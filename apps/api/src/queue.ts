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

// WhatsApp fora do ar (ou a API reiniciando): não é culpa da oferta. Antes cada envio gastava as 3 tentativas em
// ~1 minuto e virava "falhou" de vez; agora espera o número voltar, sem gastar tentativa, por até OFFLINE_MAX_MS.
// Depois disso a oferta já ficou velha e o envio é dado como falho.
export const OFFLINE_RETRY_MS = 60_000;
export const OFFLINE_MAX_MS = 6 * 60 * 60_000;
export const isOfflineError = (e: any) => /não (está )?conectado|fetch failed|ECONNREFUSED|ECONNRESET/i.test(String(e?.message || e) + String(e?.cause?.code || ''));

export type RetryResult = 'retry' | 'waiting' | 'gave-up' | 'failed';

/**
 * Depois de uma falha: WhatsApp desconectado → espera e tenta de novo sem gastar tentativa;
 * outro erro → se ainda há tentativas, volta para PENDING com um atraso (30s, 60s...). Senão fica FAILED.
 */
export async function scheduleRetry(jobId: string, err?: any): Promise<RetryResult> {
  const job = await prisma.promotionJob.findUnique({ where: { id: jobId }, select: { attempts: true, status: true, createdAt: true, automationId: true, channel: { select: { type: true } } } });
  if (!job || job.status !== 'FAILED') return 'failed';
  if (isOfflineError(err)) {
    if (Date.now() - job.createdAt.getTime() < OFFLINE_MAX_MS) {
      await prisma.promotionJob.update({ where: { id: jobId }, data: { status: 'PENDING', attempts: Math.max(0, job.attempts - 1), errorMessage: 'Esperando o WhatsApp reconectar.', scheduledAt: new Date(Date.now() + OFFLINE_RETRY_MS) } });
      return 'waiting';
    }
    const msg = `O WhatsApp ficou desconectado por mais de ${OFFLINE_MAX_MS / 3_600_000} horas; a oferta não foi enviada.`;
    await prisma.promotionJob.update({ where: { id: jobId }, data: { errorMessage: msg } }).catch(() => {});
    await prisma.automationLog.create({ data: { automationId: job.automationId, channel: job.channel.type, action: 'SEND', status: 'ERROR', message: msg } }).catch(() => {});
    return 'gave-up';
  }
  if (job.attempts >= MAX_ATTEMPTS) return 'failed';
  const delayMs = 30_000 * Math.max(1, job.attempts);
  await prisma.promotionJob.update({ where: { id: jobId }, data: { status: 'PENDING', scheduledAt: new Date(Date.now() + delayMs) } });
  return 'retry';
}

/**
 * Só há um worker: um envio PROCESSING que ele não está rodando agora ficou preso (queda do worker, ou o banco
 * caiu bem na hora de marcar a falha). Volta para PENDING. `inFlight`: os que o worker está rodando neste momento.
 */
export async function releaseStuckJobs(inFlight: string[] = []): Promise<number> {
  const r = await prisma.promotionJob.updateMany({ where: { status: 'PROCESSING', ...(inFlight.length ? { id: { notIn: inFlight } } : {}) }, data: { status: 'PENDING' } });
  return r.count;
}
