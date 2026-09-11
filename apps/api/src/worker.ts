import 'dotenv/config';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from './db';
import { executePromotionJob } from './services/promotion';
import { decryptSecret, encryptSecret } from './services/crypto';
import { refreshMercadoLivreToken } from './integrations/mercadolivre-oauth';

const connection=new IORedis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:null});
new Worker('promotions',async(job)=>executePromotionJob(job.data.jobId),{connection,concurrency:5});

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
setInterval(()=>refreshTokens().catch(console.error),5*60*1000);
refreshTokens().catch(console.error);
console.log('Worker de promoções ativo.');
