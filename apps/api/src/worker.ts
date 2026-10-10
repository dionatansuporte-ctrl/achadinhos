import 'dotenv/config';
import { prisma } from './db';
import { executePromotionJob } from './services/promotion';
import { claimPromotionJobs, scheduleRetry, releaseStuckJobs } from './queue';
import { decryptSecret, encryptSecret } from './services/crypto';
import { refreshMercadoLivreToken } from './integrations/mercadolivre-oauth';

// ---------- Fila de envios (lê a tabela PromotionJob no Postgres; sem Redis) ----------
const CONCURRENCY = 5;
const POLL_MS = 2000;
let running = 0;
let polling = false;
const inFlight = new Set<string>();
// Envios esperando o WhatsApp voltar: avisa no log só uma vez por envio, não a cada minuto.
const waitingNoted = new Set<string>();

async function runJob(jobId: string) {
  try {
    await executePromotionJob(jobId);
    if (waitingNoted.delete(jobId)) console.log(`Envio ${jobId} saiu depois que o WhatsApp voltou.`);
  } catch (e: any) {
    // Erro antes de o envio começar (banco oscilou, link da Shopee...): o job ainda está PROCESSING.
    // Marca como falha para a nova tentativa funcionar; se nem isso der, a varredura de presos devolve ele à fila.
    await prisma.promotionJob.updateMany({ where: { id: jobId, status: 'PROCESSING' }, data: { status: 'FAILED', errorMessage: String(e?.message || e).slice(0, 500) } }).catch(() => {});
    const r = await scheduleRetry(jobId, e).catch(() => 'failed' as const);
    if (r === 'waiting') {
      if (!waitingNoted.has(jobId)) { waitingNoted.add(jobId); console.log(`Envio ${jobId} esperando o WhatsApp reconectar (tenta de novo a cada minuto).`); }
      return;
    }
    waitingNoted.delete(jobId);
    console.error(`Envio ${jobId} falhou${r === 'retry' ? ', vai tentar de novo' : ''}:`, e?.message || e);
  }
}

async function tick() {
  if (polling || running >= CONCURRENCY) return;
  polling = true;
  try {
    const ids = await claimPromotionJobs(CONCURRENCY - running);
    for (const id of ids) {
      running++; inFlight.add(id);
      runJob(id).finally(() => { running--; inFlight.delete(id); });
    }
  } catch (e: any) {
    console.error('Fila: erro ao buscar envios:', e?.message || e);
  } finally {
    polling = false;
  }
}

// ---------- Renovação de tokens do Mercado Livre ----------
async function refreshTokens(){
  const accounts=await prisma.affiliateAccount.findMany({where:{marketplace:'MERCADO_LIVRE',refreshToken:{not:null}}});
  for(const a of accounts){
    if(a.expiresAt && a.expiresAt.getTime()>Date.now()+5*60*1000) continue;
    try{
      const r=await refreshMercadoLivreToken(decryptSecret(a.refreshToken!));
      await prisma.affiliateAccount.update({where:{id:a.id},data:{accessToken:encryptSecret(r.access_token),refreshToken:encryptSecret(r.refresh_token),expiresAt:new Date(Date.now()+r.expires_in*1000),externalUserId:String(r.user_id)}});
    }catch(e){console.error('Falha refresh ML',a.id,e);}
  }
}

async function main() {
  const released = await releaseStuckJobs();
  if (released) console.log(`Fila: ${released} envio(s) que ficaram presos voltaram para a fila.`);
  setInterval(() => tick().catch(console.error), POLL_MS);
  // A cada 2 min: devolve à fila o envio que ficou preso em PROCESSING sem estar rodando.
  // Usa a mesma trava do tick para não pegar um job que acabou de ser reservado e ainda não entrou em inFlight.
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try { const n = await releaseStuckJobs([...inFlight]); if (n) console.log(`Fila: ${n} envio(s) presos voltaram para a fila.`); }
    catch { /* banco fora: tenta na próxima */ }
    finally { polling = false; }
  }, 2 * 60_000);
  tick().catch(console.error);
  setInterval(()=>refreshTokens().catch(console.error),5*60*1000);
  refreshTokens().catch(console.error);
  console.log('Worker de promoções ativo (fila no Postgres).');
}
main().catch(e => { console.error('Worker não subiu:', e); process.exit(1); });
