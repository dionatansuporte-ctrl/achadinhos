import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { ROOT } from './backup';

/**
 * Limpeza da base a cada CLEANUP_EVERY_DAYS dias (pedido do usuário em 2026-10-01: "a cada 5 dias exclua
 * para renovar a base"). Roda de madrugada no agendador, depois do backup. Apaga o que tem mais de
 * KEEP_DAYS dias:
 *   - AutomationLog (histórico das automações);
 *   - PromotionJob enviados/falhos. Exceção: o envio é o que impede repetir produto no mesmo grupo,
 *     então fica pelo menos `repeatAfterDays` da automação; com "nunca repetir" (0) não sai nunca.
 *     Na fila (PENDING/PROCESSING) nunca sai;
 *   - CustomerRequest (conversas do atendimento; o cliente e o nome dele ficam);
 *   - sessões vencidas, códigos de senha/OAuth usados ou vencidos;
 *   - entradas e saídas dos grupos (GroupMemberEvent) com mais de MEMBER_EVENT_DAYS dias: o quadro mostra no
 *     máximo 30 dias, e cada entrada/saída em cada grupo é uma linha, para sempre (2026-10-09).
 *     GroupInviteSent NÃO sai: é ele que impede mandar o mesmo convite duas vezes;
 *   - arquivos de log do PostgreSQL antigos; logs do sistema grandes ficam só com o final.
 * O rodízio de termos conta as rodadas no AutomationLog: antes de apagar, a contagem vai para uma linha
 * CURSOR por automação (keywordCursor soma as duas), senão o rodízio voltaria ao primeiro termo.
 */

export const CLEANUP_EVERY_DAYS = 5;
const KEEP_DAYS = 5;
const MEMBER_EVENT_DAYS = 90;
const DAY = 86_400_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;   // log do sistema acima disso...
const LOG_KEEP_BYTES = 1024 * 1024;      // ...fica só com o último 1 MB
const ROUND_ACTIONS = ['RUN', 'GENERATE_JOBS'];

export type CleanupResult = { logs: number; jobs: number; conversations: number; sessions: number; codes: number; files: number; memberEvents?: number; dryRun: boolean };

/** Rodadas já apagadas desta automação (linha CURSOR) + as que ainda estão no log: posição do rodízio. */
export async function roundCount(automationId: string) {
  const [count, cursor] = await Promise.all([
    prisma.automationLog.count({ where: { automationId, action: { in: ROUND_ACTIONS } } }),
    prisma.automationLog.findFirst({ where: { automationId, action: 'CURSOR' }, select: { metadataJson: true } })
  ]);
  return count + (Number((cursor?.metadataJson as any)?.offset) || 0);
}

export async function lastCleanupAt(): Promise<Date | null> {
  const r = await prisma.automationLog.findFirst({ where: { action: 'CLEANUP', status: 'OK' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return r?.createdAt ?? null;
}

export async function isCleanupDue(now = new Date()) {
  const last = await lastCleanupAt();
  return !last || now.getTime() - last.getTime() >= CLEANUP_EVERY_DAYS * DAY - 6 * 3600_000; // folga: roda na mesma madrugada
}

export async function cleanupDatabase(opts: { dryRun?: boolean; now?: Date } = {}): Promise<CleanupResult> {
  const now = opts.now || new Date();
  const dry = !!opts.dryRun;
  const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY);
  const out: CleanupResult = { logs: 0, jobs: 0, conversations: 0, sessions: 0, codes: 0, files: 0, dryRun: dry };

  // 1) Posição do rodízio: guarda quantas rodadas vão ser apagadas de cada automação.
  const rounds = await prisma.automationLog.groupBy({ by: ['automationId'], where: { action: { in: ROUND_ACTIONS }, createdAt: { lt: cutoff }, automationId: { not: null } }, _count: { _all: true } });
  if (!dry) {
    for (const r of rounds) {
      const id = r.automationId!;
      const cur = await prisma.automationLog.findFirst({ where: { automationId: id, action: 'CURSOR' } });
      const offset = (Number((cur?.metadataJson as any)?.offset) || 0) + r._count._all;
      if (cur) await prisma.automationLog.update({ where: { id: cur.id }, data: { metadataJson: { offset } } });
      else await prisma.automationLog.create({ data: { automationId: id, action: 'CURSOR', status: 'OK', message: 'Posição do rodízio de termos (rodadas já apagadas pela limpeza).', metadataJson: { offset } } });
    }
  }

  // 2) Histórico das automações (menos a linha CURSOR e a última limpeza, que marcam estado).
  const logWhere = { createdAt: { lt: cutoff }, action: { notIn: ['CURSOR', 'CLEANUP'] } };
  out.logs = dry ? await prisma.automationLog.count({ where: logWhere }) : (await prisma.automationLog.deleteMany({ where: logWhere })).count;
  if (!dry) await prisma.automationLog.deleteMany({ where: { action: 'CLEANUP', createdAt: { lt: cutoff } } });

  // 3) Envios: por automação, respeitando a janela de repetição dela.
  const autos = await prisma.automation.findMany({ select: { id: true, scheduleJson: true } });
  for (const a of autos) {
    const raw = (a.scheduleJson as any)?.repeatAfterDays;
    const repeat = typeof raw === 'number' && raw >= 0 ? raw : 3;
    if (repeat === 0) {
      // "Nunca repetir": o envio precisa ficar. Só sai o que falhou.
      const w = { automationId: a.id, status: 'FAILED' as const, createdAt: { lt: cutoff } };
      out.jobs += dry ? await prisma.promotionJob.count({ where: w }) : (await prisma.promotionJob.deleteMany({ where: w })).count;
      continue;
    }
    const keepFrom = new Date(now.getTime() - Math.max(KEEP_DAYS, repeat) * DAY);
    const w = { automationId: a.id, status: { in: ['SENT', 'FAILED'] as ('SENT' | 'FAILED')[] }, createdAt: { lt: keepFrom } };
    out.jobs += dry ? await prisma.promotionJob.count({ where: w }) : (await prisma.promotionJob.deleteMany({ where: w })).count;
  }

  // 4) Conversas do atendimento. Pergunta pendente (ASK, LIMITED...) vale no máximo 24 h, então 5 dias é seguro.
  const convWhere = { createdAt: { lt: cutoff } };
  out.conversations = dry ? await prisma.customerRequest.count({ where: convWhere }) : (await prisma.customerRequest.deleteMany({ where: convWhere })).count;

  // 5) Sessões vencidas e códigos (troca de senha, OAuth) usados ou vencidos.
  const sesWhere = { expiresAt: { lt: now } };
  out.sessions = dry ? await prisma.session.count({ where: sesWhere }) : (await prisma.session.deleteMany({ where: sesWhere })).count;
  const codeWhere = { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] };
  out.codes = dry ? await prisma.oAuthState.count({ where: codeWhere }) : (await prisma.oAuthState.deleteMany({ where: codeWhere })).count;

  // 5b) Entradas e saídas dos grupos mais velhas que o quadro consegue mostrar.
  const evWhere = { at: { lt: new Date(now.getTime() - MEMBER_EVENT_DAYS * DAY) } };
  out.memberEvents = dry ? await prisma.groupMemberEvent.count({ where: evWhere }) : (await prisma.groupMemberEvent.deleteMany({ where: evWhere })).count;

  // 6) Arquivos: logs diários do PostgreSQL antigos; logs do sistema grandes ficam só com o final.
  out.files += cleanPgLogs(cutoff, dry);
  out.files += trimSystemLogs(dry);

  if (!dry) {
    const msg = `Limpeza: ${out.logs} registro(s) de automação, ${out.jobs} envio(s), ${out.conversations} mensagem(ns) de clientes, ${out.sessions + out.codes} sessão(ões)/código(s), ${out.files} arquivo(s) de log.`;
    await prisma.automationLog.create({ data: { action: 'CLEANUP', status: 'OK', message: msg, metadataJson: out as any } });
  }
  return out;
}

function pgLogDir() {
  const dirs = [process.env.PGSQL_DIR, path.join(ROOT, '..', 'pgsql'), path.join(ROOT, 'pgsql')].filter((d): d is string => !!d);
  return dirs.map(d => path.join(d, 'data', 'log')).find(d => fs.existsSync(d));
}

function cleanPgLogs(cutoff: Date, dry: boolean) {
  const dir = pgLogDir();
  if (!dir) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^postgresql-.*\.log$/.test(f)) continue;
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).mtime < cutoff) { if (!dry) fs.unlinkSync(p); n++; }
    } catch { /* arquivo em uso: fica para a próxima */ }
  }
  return n;
}

/** api.log, worker.log... recebem linhas o tempo todo (rodar.js mantém aberto em modo append): corta só o começo. */
function trimSystemLogs(dry: boolean) {
  const dir = path.join(ROOT, 'logs');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.log')) continue;
    const p = path.join(dir, f);
    try {
      const size = fs.statSync(p).size;
      if (size <= LOG_MAX_BYTES) continue;
      n++;
      if (dry) continue;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(LOG_KEEP_BYTES);
      fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
      fs.closeSync(fd);
      const tail = buf.subarray(buf.indexOf(10) + 1); // começa numa linha inteira
      fs.writeFileSync(p, Buffer.concat([Buffer.from(`--- log cortado pela limpeza em ${new Date().toISOString()} ---\n`), tail]));
    } catch { /* em uso: tenta na próxima */ }
  }
  return n;
}
