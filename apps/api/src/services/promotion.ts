import { prisma } from '../db';
import { sendWhatsAppText } from '../integrations/whatsapp';
import { publishInstagramImage } from '../integrations/instagram';

/**
 * Grupos de WhatsApp saem pela sessão Baileys, que vive só no processo da API
 * (uma sessão por número). O worker pede o envio pelo endpoint interno.
 */
async function sendToWhatsAppGroup(jid: string, text: string, imageUrl?: string) {
  const base = process.env.API_URL || 'http://localhost:3333';
  const r = await fetch(`${base}/internal/whatsapp/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.JWT_SECRET || '' },
    body: JSON.stringify({ jid, text, imageUrl: imageUrl || undefined })
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || 'Falha ao enviar para o grupo.');
  return data;
}

export async function executePromotionJob(jobId:string){
  const job=await prisma.promotionJob.findUnique({where:{id:jobId},include:{channel:true,automation:true}}); if(!job)throw new Error('Job não encontrado.');
  const payload:any=job.payloadJson||{}; await prisma.promotionJob.update({where:{id:jobId},data:{status:'PROCESSING',attempts:{increment:1}}});
  try{
    if(job.channel.type==='WHATSAPP') await sendWhatsAppText(job.channel.destination,payload.text||'');
    else if(job.channel.type==='WHATSAPP_GROUP') await sendToWhatsAppGroup(job.channel.destination,payload.text||'',payload.imageUrl);
    else { if(!payload.imageUrl) throw new Error('Instagram exige imageUrl pública para publicação.'); await publishInstagramImage(payload.imageUrl,payload.text||''); }
    await prisma.promotionJob.update({where:{id:jobId},data:{status:'SENT',sentAt:new Date(),errorMessage:null}});
    await prisma.automationLog.create({data:{automationId:job.automationId,channel:job.channel.type,action:'SEND',status:'OK',message:`Envio realizado: ${job.channel.name}`}});
  }catch(e:any){
    await prisma.promotionJob.update({where:{id:jobId},data:{status:'FAILED',errorMessage:e.message}});
    await prisma.automationLog.create({data:{automationId:job.automationId,channel:job.channel.type,action:'SEND',status:'ERROR',message:e.message}}); throw e;
  }
}
