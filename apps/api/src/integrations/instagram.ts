import { getSecret } from '../services/settings';

export async function publishInstagramImage(imageUrl: string, caption: string) {
  const token=await getSecret('META_ACCESS_TOKEN'); const igUserId=await getSecret('META_IG_USER_ID'); const version=(await getSecret('META_API_VERSION'))||'v23.0';
  if(!token||!igUserId) throw new Error('META_ACCESS_TOKEN/META_IG_USER_ID não configurados.');
  const container=await fetch(`https://graph.facebook.com/${version}/${igUserId}/media`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({image_url:imageUrl,caption})});
  const c=await container.json(); if(!container.ok)throw new Error(c?.error?.message||'Falha ao criar mídia no Instagram.');
  const publish=await fetch(`https://graph.facebook.com/${version}/${igUserId}/media_publish`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({creation_id:c.id})});
  const p=await publish.json(); if(!publish.ok)throw new Error(p?.error?.message||'Falha ao publicar no Instagram.'); return p;
}
