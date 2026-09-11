import { getSecret } from '../services/settings';

export async function sendWhatsAppText(to: string, text: string) {
  const token = await getSecret('META_ACCESS_TOKEN');
  const phoneNumberId = await getSecret('META_PHONE_NUMBER_ID');
  const version = (await getSecret('META_API_VERSION')) || 'v23.0';
  if (!token || !phoneNumberId) throw new Error('META_ACCESS_TOKEN/META_PHONE_NUMBER_ID não configurados.');
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:text,preview_url:true}})
  });
  const data=await response.json(); if(!response.ok) throw new Error(data?.error?.message||'Falha ao enviar WhatsApp.'); return data;
}
