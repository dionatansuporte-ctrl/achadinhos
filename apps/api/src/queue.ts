import { prisma } from './db';

/**
 * Fila de envios em cima do próprio Postgres (sem Redis).
 * A tabela PromotionJob É a fila: criar a linha com status PENDING e scheduledAt já enfileira.
 * O worker pega os jobs vencidos com FOR UPDATE SKIP LOCKED, marca PROCESSING e executa.
 */

export const MAX_ATTEMPTS = 3;

/** Pega até `limit` jobs prontos (PENDING com scheduledAt vencido) e marca PROCESSING, sem dois workers pegarem o mesmo. */
export async function claimPromotionJobs(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  // O Prisma grava scheduledAt em UTC numa coluna "timestamp" sem fuso. Comparar com now() puro usa o fuso
  // da sessão do Postgres (o portátil no Windows fica em America/Sao_Paulo) e atrasava cada envio em 3 horas.
  // "now() AT TIME ZONE 'utc'" devolve o horário atual em UTC sem fuso, igual ao que está gravado.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "PromotionJob" SET status = 'PROCESSING'
    WHERE id IN (
      SELECT id FROM "PromotionJob"
      WHERE status = 'PENDING' AND "scheduledAt" <= (now() AT TIME ZONE 'utc')
      ORDER BY "scheduledAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map(r => r.id);
}

/** Depois de uma falha: se ainda há tentativas, volta para PENDING com um atraso (30s, 60s...). Senão fica FAILED. */
export async function scheduleRetry(jobId: string): Promise<boolean> {
  const job = await prisma.promotionJob.findUnique({ where: { id: jobId }, select: { attempts: true, status: true } });
  if (!job || job.status !== 'FAILED' || job.attempts >= MAX_ATTEMPTS) return false;
  const delayMs = 30_000 * job.attempts;
  await prisma.promotionJob.update({ where: { id: jobId }, data: { status: 'PENDING', scheduledAt: new Date(Date.now() + delayMs) } });
  return true;
}

/** Só há um worker: o que estava PROCESSING quando ele subiu ficou preso por queda anterior. Volta para PENDING. */
export async function releaseStuckJobs(): Promise<number> {
  const r = await prisma.promotionJob.updateMany({ where: { status: 'PROCESSING' }, data: { status: 'PENDING' } });
  return r.count;
}
