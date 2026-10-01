import { prisma } from '../db';
import { runAutomation, type ScheduleJson } from './automation-runner';
import { createBackup, isAutoBackupDue, AUTO_EVERY_DAYS } from './backup';
import { cleanupDatabase, isCleanupDue, CLEANUP_EVERY_DAYS } from './cleanup';
import { tickCoupons } from './coupons';

/**
 * Agendador das automações. A cada minuto olha as automações ativas com intervalo
 * definido e dispara as que estão dentro da janela do dia (início–fim, no fuso da
 * automação) e cujo último disparo já ficou para trás em `everyMinutes`.
 *
 * O "último disparo" é o log RUN mais recente, então não precisa de coluna nova.
 */

const TICK_MS = 60_000;
let running = false;

/** Minutos desde a meia-noite no fuso informado. */
export function minutesOfDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

const toMin = (hhmm?: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** Janela do dia; aceita virar a meia-noite (ex.: 20:00 → 02:00). */
export function inWindow(nowMin: number, start?: string, end?: string): boolean {
  const s = toMin(start); const e = toMin(end);
  if (s === undefined && e === undefined) return true;
  if (s !== undefined && e === undefined) return nowMin >= s;
  if (s === undefined && e !== undefined) return nowMin <= e!;
  return s! <= e! ? nowMin >= s! && nowMin <= e! : nowMin >= s! || nowMin <= e!;
}

/** Quando a automação dispara de novo, ou null se não está agendada. */
export function describeSchedule(schedule: ScheduleJson | null | undefined): string | null {
  if (!schedule?.everyMinutes) return null;
  const every = schedule.everyMinutes >= 60 && schedule.everyMinutes % 60 === 0 ? `${schedule.everyMinutes / 60}h` : `${schedule.everyMinutes} min`;
  const win = schedule.startTime || schedule.endTime ? ` das ${schedule.startTime || '00:00'} às ${schedule.endTime || '23:59'}` : '';
  return `a cada ${every}${win}`;
}

/** Limpeza da base a cada CLEANUP_EVERY_DAYS dias, na mesma janela da madrugada. */
async function autoCleanup() {
  if (!(await isCleanupDue())) return;
  backupRunning = true;
  try {
    const r = await cleanupDatabase();
    console.log(`[limpeza] ${r.logs} log(s), ${r.jobs} envio(s), ${r.conversations} conversa(s), ${r.sessions + r.codes} sessão(ões)/código(s), ${r.files} arquivo(s) (próxima em ${CLEANUP_EVERY_DAYS} dias)`);
  } catch (e: any) {
    backupFailedAt = Date.now();
    console.error('[limpeza] falhou:', e.message);
    await prisma.automationLog.create({ data: { action: 'CLEANUP', status: 'ERROR', message: e.message } }).catch(() => {});
  } finally {
    backupRunning = false;
  }
}

/** Backup automático a cada AUTO_EVERY_DAYS dias (o anterior é apagado), entre 03:00 e 05:59 (SP), quando o sistema está ocioso. */
// Falhou? Tenta de novo só depois de 1 h (antes eram ~180 tentativas, uma por minuto, até as 6h).
let backupRunning = false;
let backupFailedAt = 0;
async function autoBackup() {
  const m = minutesOfDay(new Date(), 'America/Sao_Paulo');
  if (m < 3 * 60 || m >= 6 * 60) return;
  if (backupRunning || Date.now() - backupFailedAt < 60 * 60_000) return;
  // Backup em dia: é a vez da limpeza (sempre depois do backup, para o zip guardar o que vai ser apagado).
  if (!isAutoBackupDue()) { await autoCleanup(); return; }
  backupRunning = true;
  try {
    const b = await createBackup('auto');
    console.log(`[backup] automático criado: ${b.file} (próximo em ${AUTO_EVERY_DAYS} dias)`);
  } catch (e: any) {
    backupFailedAt = Date.now();
    console.error('[backup] automático falhou:', e.message);
    await prisma.automationLog.create({ data: { action: 'BACKUP', status: 'ERROR', message: e.message } }).catch(() => {});
  } finally {
    backupRunning = false;
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // Em paralelo: o backup leva minutos e não pode segurar as automações e os cupons.
    autoBackup().catch(() => {});
    const now = new Date();
    await tickCoupons(now).catch(e => console.error('[cupons] falha no tick:', e.message));
    const list = await prisma.automation.findMany({ where: { status: 'ACTIVE' } });
    for (const a of list) {
      const s = (a.scheduleJson || {}) as ScheduleJson;
      const every = Number(s.everyMinutes);
      if (!every || every <= 0) continue;
      // Fuso inválido salvo numa automação não pode parar as outras (minutesOfDay lança RangeError).
      let minutes: number;
      try { minutes = minutesOfDay(now, a.timezone || 'America/Sao_Paulo'); } catch { minutes = minutesOfDay(now, 'America/Sao_Paulo'); }
      if (!inWindow(minutes, s.startTime, s.endTime)) continue;

      const last = await prisma.automationLog.findFirst({ where: { automationId: a.id, action: 'RUN' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      // Tolerância de 30s para o tick de 1 min não "perder" o intervalo.
      if (last && now.getTime() - last.createdAt.getTime() < every * 60_000 - 30_000) continue;

      try {
        const r = await runAutomation(a.id, { source: 'scheduler', perRun: s.perRun || 1 });
        console.log(`[agendador] ${a.name}: ${r.message}`);
      } catch (e: any) {
        // Registra como RUN para respeitar o intervalo mesmo em erro (evita martelar a API).
        await prisma.automationLog.create({ data: { automationId: a.id, action: 'RUN', status: 'ERROR', message: e.message } });
        console.error(`[agendador] ${a.name}: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error('[agendador] falha no tick:', e.message);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  console.log('Agendador de automações ativo (verifica a cada 1 min).');
}
