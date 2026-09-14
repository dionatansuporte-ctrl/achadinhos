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

async function runJob(jobId: string) {
  try {
    await executePromotionJob(jobId);
  } catch (e: any) {
    const retry = await scheduleRetry(jobId).catch(() => false);
    console.error(`Envio ${jobId} falhou${retry ? ', vai tentar de novo' : ''}:`, e?.message || e);
  }
}

async function tick() {
  if (polling || running >= CONCURRENCY) return;
  polling = true;
  try {
    const ids = await claimPromotionJobs(CONCURRENCY - running);
    for (const id of ids) {
      running++;
      runJob(id).finally(() => { running--; });
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
  tick().catch(console.error);
  setInterval(()=>refreshTokens().catch(console.error),5*60*1000);
  refreshTokens().catch(console.error);
  console.log('Worker de promoções ativo (fila no Postgres).');
}
main().catch(e => { console.error('Worker não subiu:', e); process.exit(1); });
