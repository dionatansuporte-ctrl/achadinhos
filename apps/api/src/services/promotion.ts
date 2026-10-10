import { prisma } from '../db';
import { sendWhatsAppText } from '../integrations/whatsapp';
import { publishInstagramImage } from '../integrations/instagram';
import { shopeeTrackedLink } from '../integrations/shopee';
import { isOfflineError } from '../queue';

/**
 * Grupos de WhatsApp saem pela sessão Baileys, que vive só no processo da API
 * (uma sessão por número). O worker pede o envio pelo endpoint interno.
 */
async function sendToWhatsAppGroup(jid: string, text: string, imageUrl: string | undefined, jobId: string) {
  const base = process.env.API_URL || 'http://localhost:3333';
  const r = await fetch(`${base}/internal/whatsapp/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.JWT_SECRET || '' },
    // jobId permite à API marcar o envio como entregue e recusar repetição do mesmo job.
    body: JSON.stringify({ jid, text, imageUrl: imageUrl || undefined, jobId })
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || 'Falha ao enviar para o grupo.');
  return data;
}

export async function executePromotionJob(jobId:string){
  const job=await prisma.promotionJob.findUnique({where:{id:jobId},include:{channel:true,automation:true,product:{select:{marketplace:true,productUrl:true}}}}); if(!job)throw new Error('Job não encontrado.');
  // Idempotência: a fila tenta de novo quando a tentativa anterior lançou erro. Se o envio na verdade
  // saiu (a API marcou SENT ao entregar, mas a resposta se perdeu), não manda em dobro.
  if(job.status==='SENT') return;
  // Canal pausado depois de o envio entrar na fila: não manda, e não lança erro para a fila não tentar de novo.
  if(!job.channel.enabled){
    await prisma.promotionJob.update({where:{id:jobId},data:{status:'FAILED',errorMessage:'Envio parado: o canal está pausado.'}}).catch(()=>{});
    return;
  }
  const payload:any=job.payloadJson||{}; await prisma.promotionJob.update({where:{id:jobId},data:{status:'PROCESSING',attempts:{increment:1}}});
  // Shopee: o link sai marcado com o grupo (subId "g<canal>") para a tela de Vendas mostrar de onde veio cada pedido.
  if(job.product?.marketplace==='SHOPEE'&&job.channel.type!=='INSTAGRAM'&&payload.affiliateUrl&&payload.text?.includes(payload.affiliateUrl)){
    const tracked=payload.trackedUrl||await shopeeTrackedLink(job.product.productUrl,`g${job.channel.id}`);
    if(tracked){
      payload.text=payload.text.split(payload.affiliateUrl).join(tracked);
      if(!payload.trackedUrl) await prisma.promotionJob.update({where:{id:jobId},data:{payloadJson:{...(job.payloadJson as any),trackedUrl:tracked}}}).catch(()=>{});
    }
  }
  try{
    if(job.channel.type==='WHATSAPP') await sendWhatsAppText(job.channel.destination,payload.text||'');
    else if(job.channel.type==='WHATSAPP_GROUP') await sendToWhatsAppGroup(job.channel.destination,payload.text||'',payload.imageUrl,jobId);
    else { if(!payload.imageUrl) throw new Error('Instagram exige imageUrl pública para publicação.'); await publishInstagramImage(payload.imageUrl,payload.text||''); }
  }catch(e:any){
    await prisma.promotionJob.update({where:{id:jobId},data:{status:'FAILED',errorMessage:e.message}}).catch(()=>{});
    // WhatsApp fora do ar: a fila espera ele voltar; não enche o Histórico com um erro por minuto.
    if(!isOfflineError(e)) await prisma.automationLog.create({data:{automationId:job.automationId,channel:job.channel.type,action:'SEND',status:'ERROR',message:e.message}}).catch(()=>{});
    throw e;
  }
  // Já saiu: daqui em diante um erro do banco NÃO pode virar FAILED, senão a fila tenta de novo e manda em dobro.
  await prisma.promotionJob.update({where:{id:jobId},data:{status:'SENT',sentAt:new Date(),errorMessage:null}})
    .catch(e=>console.error(`[envio] ${jobId} saiu, mas não consegui marcar SENT:`,e.message));
  await prisma.automationLog.create({data:{automationId:job.automationId,channel:job.channel.type,action:'SEND',status:'OK',message:`Envio realizado: ${job.channel.name}`}}).catch(()=>{});
}
