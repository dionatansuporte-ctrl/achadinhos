import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Senha do PostgreSQL fora do .env: fica em apps/api/.db-secret, criptografada com a DPAPI do Windows
 * (só o usuário do Windows que a gravou, neste PC, consegue abrir). Aqui ela é aberta uma vez, no início
 * do processo, e encaixada no DATABASE_URL antes do Prisma conectar. Sem o arquivo (Linux, instalação
 * antiga), vale o DATABASE_URL do .env como está.
 */
const API_DIR = path.resolve(__dirname, '..');
const SECRET_FILE = path.join(API_DIR, '.db-secret');
const SCRIPT = path.resolve(API_DIR, '..', '..', 'tools', 'db-senha.ps1');

let applied = false;

export function applyDbSecret() {
  if (applied) return;
  applied = true;
  if (process.platform !== 'win32' || !fs.existsSync(SECRET_FILE) || !fs.existsSync(SCRIPT)) return;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, 'get'], { encoding: 'utf8', windowsHide: true });
  const password = (r.stdout || '').trim();
  if (r.status !== 0 || !password) {
    throw new Error(`Não consegui abrir a senha do banco (apps/api/.db-secret): ${(r.stderr || '').trim().slice(0, 200) || 'arquivo inválido'}. Ela só abre no mesmo usuário do Windows que a gravou.`);
  }
  const url = new URL(process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/achadinhopro');
  url.password = encodeURIComponent(password);
  process.env.DATABASE_URL = url.toString();
}
