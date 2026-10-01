import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyDbSecret } from '../db-secret';

/**
 * Backup completo do Robô das Ofertas em um .zip, para restaurar aqui ou em outra máquina:
 *   db.sql          → banco inteiro (pg_dump com DROP/CREATE, pronto para restaurar)
 *   config/api.env  → credenciais e a TOKEN_ENCRYPTION_KEY (sem ela, nada salvo em Configurações abre)
 *   config/web.env
 *   wa-auth/        → sessão do WhatsApp (evita escanear o QR de novo)
 *   source/         → o código, sem node_modules/dist/logs
 *   manifest.json
 * Usa o pg_dump do PostgreSQL portátil (pasta pgsql), robocopy e Compress-Archive: pensado para Windows.
 */

export const ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // <root>/apps/api/src/services → <root>
export const BACKUP_DIR = path.join(ROOT, 'backups');
const KEEP = 15;
/** Intervalo do backup automático, em dias. Ao gerar um novo, os automáticos anteriores são apagados. */
export const AUTO_EVERY_DAYS = 5;

export type BackupInfo = { file: string; size: number; createdAt: Date; kind: 'manual' | 'auto' };

/**
 * Roda um programa sem travar o processo. O backup roda dentro da API, junto com a sessão do
 * WhatsApp e o atendimento: com spawnSync tudo ficava parado os minutos do backup (e o WhatsApp
 * podia cair). `stdoutFile` manda a saída direto para um arquivo (o dump do banco).
 */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdoutFile?: string } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const out = opts.stdoutFile ? fs.openSync(opts.stdoutFile, 'w') : null;
    let stdout = '', stderr = '';
    const p = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: opts.env, windowsHide: true, stdio: ['ignore', out ?? 'pipe', 'pipe'] });
    p.stdout?.on('data', d => { if (stdout.length < 1_000_000) stdout += d; });
    p.stderr?.on('data', d => { if (stderr.length < 100_000) stderr += d; });
    const done = (status: number | null, err?: Error) => { if (out !== null) fs.closeSync(out); resolve({ status, stdout, stderr: stderr || err?.message || '' }); };
    p.on('error', e => done(-1, e));
    p.on('close', code => done(code));
  });
}

function dbParts() {
  applyDbSecret(); // o backup.bat roda sem a API: abre a senha do banco aqui também
  const url = new URL(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/achadinhopro');
  return {
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || 'postgres'),
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    db: url.pathname.replace(/^\//, '') || 'achadinhopro',
  };
}

/** Acha o pg_dump do PostgreSQL portátil: PGSQL_DIR, <root>\..\pgsql (ex.: C:\Criar sites\pgsql) ou <root>\pgsql. */
function findPgDump(): string | null {
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  const candidates = [process.env.PGSQL_DIR, path.join(ROOT, '..', 'pgsql'), path.join(ROOT, 'pgsql')]
    .filter((d): d is string => !!d)
    .map(d => path.join(d, 'bin', exe));
  return candidates.find(p => fs.existsSync(p)) || null;
}

/** Dump do banco com o pg_dump do PostgreSQL portátil. */
async function dumpDatabase(to: string) {
  const { user, password, host, port, db } = dbParts();
  const pgDump = findPgDump();
  if (!pgDump) throw new Error('Não achei pgsql\\bin\\pg_dump.exe. Extraia o PostgreSQL em "C:\\Criar sites\\pgsql" ou defina PGSQL_DIR.');
  const r = await run(pgDump, ['-h', host, '-p', port, '-U', user, '--clean', '--if-exists', '--no-owner', db],
    { env: { ...process.env, PGPASSWORD: password }, stdoutFile: to });
  const size = fs.existsSync(to) ? fs.statSync(to).size : 0;
  if (r.status !== 0 || size < 100) {
    throw new Error(`Falha no pg_dump: ${(r.stderr || '').trim().slice(0, 300) || 'o PostgreSQL está ligado? (tools\\postgres.bat start)'}`);
  }
  return size;
}

function copyIfExists(from: string, to: string) {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

async function copySource(to: string) {
  fs.mkdirSync(to, { recursive: true });
  // robocopy: código sem dependências, builds, logs, backups e a própria sessão do WhatsApp (vai à parte).
  const r = await run('robocopy', [ROOT, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP',
    '/XD', 'node_modules', 'dist', 'logs', 'backups', '.git', '.wa-auth', 'generated',
    '/XF', '*.log', '*.zip', '.db-secret', '.db-secret.novo']); // a senha criptografada só abre neste PC: não vai junto
  // robocopy devolve códigos < 8 em sucesso.
  if ((r.status ?? 0) >= 8) throw new Error(`Falha ao copiar o código: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
}

async function zipFolder(folder: string, zipPath: string) {
  // tar (bsdtar, nativo do Windows 10+) gera .zip e lê arquivos que o antivírus ainda está
  // inspecionando; o Compress-Archive falha com "usado por outro processo" nesses casos.
  // Caminho completo: com o Git instalado, "tar" no PATH pode ser o GNU tar, que não gera .zip.
  const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  let r = await run(fs.existsSync(winTar) ? winTar : 'tar', ['-a', '-c', '-f', zipPath, '-C', folder, '.']);
  if (r.status !== 0 || !fs.existsSync(zipPath)) {
    const ps = `Compress-Archive -Path '${folder.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`;
    r = await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  }
  if (r.status !== 0 || !fs.existsSync(zipPath)) throw new Error(`Falha ao compactar: ${(r.stderr || '').trim().slice(0, 300)}`);
}

const stamp = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(/[-: ]/g, '').slice(0, 12); // AAAAMMDDHHmm

export async function createBackup(kind: 'manual' | 'auto' = 'manual'): Promise<BackupInfo> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const name = `ofertasdahora-${stamp(now)}-${kind}.zip`;
  const zipPath = path.join(BACKUP_DIR, name);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ofertasdahora-bkp-'));
  try {
    const dbBytes = await dumpDatabase(path.join(staging, 'db.sql'));
    copyIfExists(path.join(ROOT, 'apps', 'api', '.env'), path.join(staging, 'config', 'api.env'));
    copyIfExists(path.join(ROOT, 'apps', 'web', '.env'), path.join(staging, 'config', 'web.env'));
    const wa = copyIfExists(path.join(ROOT, 'apps', 'api', '.wa-auth'), path.join(staging, 'wa-auth'));
    await copySource(path.join(staging, 'source'));
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      app: 'Robô das Ofertas', createdAt: now.toISOString(), kind, host: os.hostname(), dbBytes, whatsappSession: wa,
      restore: 'Arraste este .zip sobre o OfertasDaHora.bat (na raiz do projeto) ou use a opção Restaurar do menu. Em outra máquina: extraia source/ para uma pasta e faça o mesmo com o OfertasDaHora.bat de lá.'
    }, null, 2));
    await zipFolder(staging, zipPath);
  } catch (e) {
    // Zip pela metade não pode ficar: contaria como "o automático mais recente" por 5 dias.
    fs.rmSync(zipPath, { force: true });
    throw e;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  prune();
  const st = fs.statSync(zipPath);
  return { file: name, size: st.size, createdAt: st.mtime, kind };
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^ofertasdahora-\d{12}-(manual|auto)\.zip$/.test(f))
    .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, size: st.size, createdAt: st.mtime, kind: (f.endsWith('-auto.zip') ? 'auto' : 'manual') as 'auto' | 'manual' }; })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Automáticos: fica só o mais recente (o antigo só sai depois que o novo ficou pronto).
 * Manuais: mantém os KEEP mais recentes; os dos últimos 30 dias nunca são apagados.
 */
function prune() {
  const all = listBackups();
  const cutoff = Date.now() - 30 * 86_400_000;
  const remove = (b: BackupInfo) => { try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch { /* ignora */ } };
  all.filter(b => b.kind === 'auto').slice(1).forEach(remove);
  all.filter(b => b.kind === 'manual').slice(KEEP).forEach(b => { if (b.createdAt.getTime() <= cutoff) remove(b); });
}

export function backupPath(file: string) {
  if (!/^ofertasdahora-\d{12}-(manual|auto)\.zip$/.test(file)) throw new Error('Nome de backup inválido.');
  const p = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(p)) throw new Error('Backup não encontrado.');
  return p;
}

export function deleteBackup(file: string) { fs.unlinkSync(backupPath(file)); }

/** AAAAMMDD → número do dia, para contar dias de calendário. */
const dayNumber = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 86_400_000;

/** Já passaram AUTO_EVERY_DAYS dias (fuso de SP) desde o último backup automático? */
export function isAutoBackupDue() {
  const last = listBackups().find(b => b.kind === 'auto');
  if (!last) return true;
  const lastDay = last.file.slice('ofertasdahora-'.length, 'ofertasdahora-'.length + 8);
  return dayNumber(stamp(new Date()).slice(0, 8)) - dayNumber(lastDay) >= AUTO_EVERY_DAYS;
}
