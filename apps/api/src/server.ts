import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import selfsigned from 'selfsigned';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from './db';
import { getSecret, describeSecret, saveSecrets, SETTING_KEYS } from './services/settings';
import { searchOffers, hasShopeeSearch, describeSearch } from './services/shopee-sync';
import { MARKETPLACE_LIST } from './services/marketplaces';
import { amazonAffiliateUrl, amazonTag, expandAmazonUrl, extractAsin, fetchAmazonItem, isAmazonUrl, normalizeAmazonTag } from './integrations/amazon';
import { decryptSecret } from './services/crypto';
import { runAutomation } from './services/automation-runner';
import { titleKey } from './services/title-key';
import { salesReport, clearSalesCache } from './services/reports';
import { createBackup, listBackups, backupPath, deleteBackup, BACKUP_DIR } from './services/backup';
import { startScheduler, describeSchedule } from './services/scheduler';
import { addGroupMembers, addWaSession, anyWaConnected, connectSavedSessions, connectWhatsAppWeb, getWaState, groupInviteLink, listGroupMembers, listGroups, listWaSessions, logoutWhatsAppWeb, waGroupSessions, sendWhatsAppWebText, sessionForJid } from './integrations/whatsapp-web';
import { requireAuth } from './middleware/auth';
import { hashPassword, verifyPassword, issueSession } from './services/auth';
import { isMailConfigured, sendMail, sendPasswordResetCode } from './services/mailer';
import { encryptSecret } from './services/crypto';
import { buildMercadoLivreAuthorizationUrl, exchangeMercadoLivreCode, pkcePair, refreshMercadoLivreToken, getMercadoLivreAccessToken } from './integrations/mercadolivre-oauth';
import { renderOffer, defaultOfferTemplate, toggleOldPrice } from './services/offer';
import { couponListMessage, parseValidUntil, isExpired, sendCouponList, productCoupons, pickCoupon, getSchedule, scheduleChannels, MARKETPLACES } from './services/coupons';
import { parseCouponText, importTelegramCoupons } from './services/coupon-import';
import { extractMercadoLivreItemId, fetchMercadoLivreItem } from './services/mercadolivre';
import { trendingKeywords } from './integrations/mercadolivre-search';
import { searchCategories, warmUpCategories } from './services/ml-categories';
import { getBot, customerLink, sendOffersTo, sendTextTo, startCustomerBot, parseIntent } from './services/customer-bot';
import QRCode from 'qrcode';

const app = express();
const webUrl=process.env.WEB_URL||'http://127.0.0.1:8080';
app.use(cors({ origin: [webUrl, webUrl.replace('127.0.0.1','localhost'), webUrl.replace('localhost','127.0.0.1')] }));
app.use(express.json({ limit: '1mb' }));

// Preços digitados em português usam vírgula decimal ("5,69"); Number() sozinho devolveria NaN.
const brNumber = z.preprocess(v => {
  if (v === '' || v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const t = String(v).replace(/[^0-9.,-]/g, '');
  // Padrão brasileiro: vírgula é decimal e ponto é milhar ("1.299,90"). Só com ponto,
  // "199.90" é decimal e "1.299" é milhar (mesma regra do painel, em web/src/money.ts).
  const onlyDotDecimal = !t.includes(',') && /\.\d{1,2}$/.test(t) && (t.match(/\./g) || []).length === 1;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : onlyDotDecimal ? t : t.replace(/\./g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());

// Link só http(s). O httpUrl() sozinho aceita "C:/arquivo" (o WhatsApp leria o arquivo do PC e
// mandaria como foto), "file:" e "javascript:" (link que roda código ao ser clicado).
const httpUrl = () => z.string().url().refine(u => /^https?:\/\//i.test(u), 'Use um link que comece com http:// ou https://.');

const asyncRoute = (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req,res,next)).catch(next);
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

app.get('/health', (_, res) => res.json({ ok: true, service: 'ofertasdahora-api' }));

const safeUser=(u:any)=>({id:u.id,name:u.name,email:u.email,role:u.role,status:u.status,createdAt:u.createdAt});
app.post('/api/auth/register', asyncRoute(async (req:any,res:any)=>{
  const body = z.object({ name:z.string().min(2), email:z.string().email(), password:z.string().min(8) }).parse(req.body);
  const exists = await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
  if(exists) return res.status(409).json({error:'E-mail já cadastrado.'});
  // Primeira conta do sistema vira MASTER e entra direto. As demais ficam PENDING até um
  // administrador aprovar em Usuários.
  const first = (await prisma.user.count())===0;
  const user = await prisma.user.create({data:{name:body.name,email:body.email.toLowerCase(),passwordHash:await hashPassword(body.password),role:first?'MASTER':'OPERATOR',status:first?'ACTIVE':'PENDING',approvedAt:first?new Date():null}});
  await prisma.affiliateAccount.createMany({data:[{userId:user.id,marketplace:'SHOPEE',displayName:'Shopee'},{userId:user.id,marketplace:'MERCADO_LIVRE',displayName:'Mercado Livre'},{userId:user.id,marketplace:'AMAZON',displayName:'Amazon Associados'}]});
  if(first){ const token = await issueSession(user.id); return res.status(201).json({token,user:safeUser(user)}); }
  // Avisa os administradores por e-mail (se o SMTP estiver configurado).
  try{
    if(await isMailConfigured()){
      const admins=await prisma.user.findMany({where:{role:{in:['MASTER','ADMIN']},status:'ACTIVE'},select:{email:true}});
      const link=`${process.env.WEB_URL||'http://127.0.0.1:8080'}/users`;
      await Promise.all(admins.map(a=>sendMail(a.email,'Novo cadastro aguardando aprovação · Robô das Ofertas',`${user.name} (${user.email}) pediu acesso ao Robô das Ofertas.\n\nAprove ou recuse em: ${link}`).catch(()=>{})));
    }
  }catch{ /* e-mail é só aviso */ }
  res.status(201).json({pending:true,message:'Cadastro enviado! Assim que um administrador aprovar, você poderá entrar. Você recebe um e-mail quando isso acontecer.'});
}));

app.post('/api/auth/login', asyncRoute(async (req:any,res:any)=>{
  const body = z.object({email:z.string().email(),password:z.string()}).parse(req.body);
  const user = await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
  if(!user?.passwordHash || !(await verifyPassword(body.password,user.passwordHash))) return res.status(401).json({error:'E-mail ou senha inválidos.'});
  if(user.status==='PENDING') return res.status(403).json({error:'Seu cadastro ainda não foi aprovado. Aguarde a liberação do administrador.'});
  if(user.status==='BLOCKED') return res.status(403).json({error:'Seu acesso foi bloqueado. Fale com o administrador.'});
  const token = await issueSession(user.id);
  res.json({token,user:safeUser(user)});
}));

// ---------- Usuários: aprovação de acesso ----------
const canManageUsers=(u:any)=>['MASTER','ADMIN'].includes(u.role);
app.get('/api/users/summary', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!canManageUsers(req.user)) return res.json({canManage:false,pending:0});
  res.json({canManage:true,pending:await prisma.user.count({where:{status:'PENDING'}})});
}));
app.get('/api/users', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!canManageUsers(req.user)) return res.status(403).json({error:'Somente administradores.'});
  const users=await prisma.user.findMany({orderBy:[{status:'asc'},{createdAt:'desc'}],select:{id:true,name:true,email:true,role:true,status:true,approvedAt:true,createdAt:true}});
  // PENDING primeiro na tela.
  res.json(users.sort((a,b)=>(a.status==='PENDING'?0:1)-(b.status==='PENDING'?0:1)));
}));
app.patch('/api/users/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!canManageUsers(req.user)) return res.status(403).json({error:'Somente administradores.'});
  const body=z.object({status:z.enum(['ACTIVE','BLOCKED','PENDING']).optional(),role:z.enum(['MASTER','ADMIN','OPERATOR']).optional()}).parse(req.body);
  const target=await prisma.user.findUnique({where:{id:req.params.id}}); if(!target)return res.status(404).json({error:'Usuário não encontrado.'});
  if(target.id===req.user.id && body.status && body.status!=='ACTIVE') return res.status(400).json({error:'Você não pode bloquear a própria conta.'});
  if(target.role==='MASTER' && req.user.role!=='MASTER') return res.status(403).json({error:'Só o usuário MASTER pode alterar outro MASTER.'});
  if(body.role && req.user.role!=='MASTER') return res.status(403).json({error:'Só o usuário MASTER altera perfis.'});
  const data:any={}; if(body.status){data.status=body.status; if(body.status==='ACTIVE'&&target.status!=='ACTIVE')data.approvedAt=new Date();} if(body.role)data.role=body.role;
  const updated=await prisma.user.update({where:{id:target.id},data,select:{id:true,name:true,email:true,role:true,status:true,approvedAt:true,createdAt:true}});
  if(body.status && body.status!=='ACTIVE') await prisma.session.deleteMany({where:{userId:target.id}}); // derruba quem foi bloqueado
  if(body.status==='ACTIVE' && target.status==='PENDING'){
    try{ if(await isMailConfigured()) await sendMail(target.email,'Seu acesso foi aprovado · Robô das Ofertas',`Olá${target.name?`, ${target.name}`:''}! Seu cadastro no Robô das Ofertas foi aprovado.\n\nEntre em: ${process.env.WEB_URL||'http://127.0.0.1:8080'}`); }catch{ /* aviso opcional */ }
  }
  res.json(updated);
}));
app.delete('/api/users/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!canManageUsers(req.user)) return res.status(403).json({error:'Somente administradores.'});
  const target=await prisma.user.findUnique({where:{id:req.params.id}}); if(!target)return res.status(404).json({error:'Usuário não encontrado.'});
  if(target.id===req.user.id) return res.status(400).json({error:'Você não pode excluir a própria conta.'});
  if(target.role==='MASTER') return res.status(403).json({error:'O usuário MASTER não pode ser excluído.'});
  await prisma.user.delete({where:{id:target.id}});
  res.json({ok:true});
}));

app.post('/api/auth/logout', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const token=String(req.headers.authorization||'').slice(7);
  const sid=(jwt.decode(token) as any)?.sid; if(typeof sid==='string') await prisma.session.deleteMany({where:{tokenHash:sid}});
  res.json({ok:true});
}));

app.get('/api/me', requireAuth, (req:any,res:any)=>res.json({user:safeUser(req.user)}));

// Minha conta: nome, e-mail e senha. Trocar e-mail ou senha exige a senha atual.
app.patch('/api/me', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({name:z.string().trim().min(2).max(80).optional(),email:z.string().trim().email().optional(),currentPassword:z.string().optional(),newPassword:z.string().min(8).max(128).optional()}).parse(req.body);
  const user=await prisma.user.findUnique({where:{id:req.user.id}}); if(!user)return res.status(404).json({error:'Usuário não encontrado.'});
  const email=body.email?.toLowerCase();
  const sensitive=(email&&email!==user.email)||!!body.newPassword;
  if(sensitive){
    if(!body.currentPassword||!user.passwordHash||!(await verifyPassword(body.currentPassword,user.passwordHash))) return res.status(401).json({error:'Senha atual incorreta.'});
  }
  if(email&&email!==user.email&&await prisma.user.findUnique({where:{email}})) return res.status(409).json({error:'Já existe uma conta com esse e-mail.'});
  const data:any={}; if(body.name)data.name=body.name; if(email)data.email=email; if(body.newPassword)data.passwordHash=await hashPassword(body.newPassword);
  const updated=await prisma.user.update({where:{id:user.id},data});
  let token:string|undefined;
  if(body.newPassword){ await prisma.session.deleteMany({where:{userId:user.id}}); token=await issueSession(user.id); } // derruba outros logins
  res.json({user:safeUser(updated),token});
}));

// Esqueci a senha: código de 6 dígitos por e-mail, válido por 15 min, uso único, 5 tentativas.
const RESET_MINUTES=15;
const resetHash=(userId:string,code:string)=>crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
app.post('/api/auth/forgot', asyncRoute(async(req:any,res:any)=>{
  const body=z.object({email:z.string().trim().email()}).parse(req.body);
  if(!(await isMailConfigured())) return res.status(503).json({error:'Envio de e-mail não configurado. Peça ao administrador para preencher o SMTP em Configurações.'});
  const user=await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
  // Resposta igual com ou sem conta, para não revelar quais e-mails existem.
  if(user){
    const code=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
    await prisma.oAuthState.deleteMany({where:{provider:'PASSWORD_RESET',userId:user.id}});
    await prisma.oAuthState.create({data:{provider:'PASSWORD_RESET',userId:user.id,stateHash:resetHash(user.id,code),codeVerifier:'0',expiresAt:new Date(Date.now()+RESET_MINUTES*60_000)}});
    try{ await sendPasswordResetCode(user.email,code,RESET_MINUTES); }
    catch(e:any){ console.error('E-mail de recuperação:',e.message); return res.status(502).json({error:'Não foi possível enviar o e-mail. Confira o SMTP em Configurações.'}); }
  }
  res.json({ok:true,message:`Se existir uma conta com esse e-mail, enviamos um código válido por ${RESET_MINUTES} minutos.`});
}));
app.post('/api/auth/reset', asyncRoute(async(req:any,res:any)=>{
  const body=z.object({email:z.string().trim().email(),code:z.string().trim().regex(/^\d{6}$/,'Código de 6 dígitos.'),password:z.string().min(8).max(128)}).parse(req.body);
  const user=await prisma.user.findUnique({where:{email:body.email.toLowerCase()}});
  const invalid=()=>res.status(400).json({error:'Código inválido ou expirado. Peça um novo.'});
  if(!user) return invalid();
  const st=await prisma.oAuthState.findFirst({where:{provider:'PASSWORD_RESET',userId:user.id,consumedAt:null,expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'}});
  if(!st) return invalid();
  if(st.stateHash!==resetHash(user.id,body.code)){
    const attempts=Number(st.codeVerifier||'0')+1;
    await prisma.oAuthState.update({where:{id:st.id},data:{codeVerifier:String(attempts),...(attempts>=5?{consumedAt:new Date()}:{})}});
    return invalid();
  }
  await prisma.oAuthState.update({where:{id:st.id},data:{consumedAt:new Date()}});
  await prisma.user.update({where:{id:user.id},data:{passwordHash:await hashPassword(body.password)}});
  await prisma.session.deleteMany({where:{userId:user.id}});
  const token=await issueSession(user.id);
  res.json({token,user:safeUser(user)});
}));
// Teste do SMTP: manda um e-mail para o próprio usuário logado.
app.post('/api/settings/email-test', requireAuth, asyncRoute(async(req:any,res:any)=>{
  try{ await sendMail(req.user.email,'Teste de e-mail · Robô das Ofertas','Se você recebeu isto, o SMTP está funcionando.'); res.json({ok:true,message:`E-mail de teste enviado para ${req.user.email}.`}); }
  catch(e:any){ res.status(502).json({error:e.message}); }
}));

app.get('/api/dashboard', requireAuth, asyncRoute(async (req:any,res:any)=>{
  const userId=req.user.id;
  const [products,lists,automations,pending,sent,failed,channels,accounts] = await Promise.all([
    prisma.product.count({where:{account:{userId}}}), prisma.productList.count({where:{userId}}), prisma.automation.count({where:{userId}}),
    prisma.promotionJob.count({where:{automation:{userId},status:'PENDING'}}), prisma.promotionJob.count({where:{automation:{userId},status:'SENT'}}),
    prisma.promotionJob.count({where:{automation:{userId},status:'FAILED'}}), prisma.channel.count({where:{userId,enabled:true}}), prisma.affiliateAccount.count({where:{userId,accessToken:{not:null}}})
  ]);
  res.json({products,lists,automations,pending,sent,failed,channels,accounts});
}));

app.get('/api/lists', requireAuth, asyncRoute(async(req:any,res:any)=>res.json(await prisma.productList.findMany({where:{userId:req.user.id},include:{products:{include:{product:true}}},orderBy:{createdAt:'desc'}}))));
app.post('/api/lists', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({name:z.string().min(2),description:z.string().optional()}).parse(req.body);
  res.status(201).json(await prisma.productList.create({data:{...body,userId:req.user.id}}));
}));
app.post('/api/lists/:id/products', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({productId:z.string()}).parse(req.body);
  const list=await prisma.productList.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!list)return res.status(404).json({error:'Lista não encontrada.'});
  if(!(await prisma.product.findFirst({where:{id:body.productId,account:{userId:req.user.id}}}))) return res.status(404).json({error:'Produto não encontrado.'});
  res.status(201).json(await prisma.listProduct.create({data:{listId:list.id,productId:body.productId}}));
}));

app.delete('/api/lists/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const list=await prisma.productList.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!list)return res.status(404).json({error:'Lista não encontrada.'});
  const usadas=await prisma.automation.findMany({where:{listId:list.id},select:{name:true}});
  const force=req.query.force==='1'||req.query.force==='true';
  if(usadas.length && !force) return res.status(409).json({error:`Linha usada pela automação: ${usadas.map(a=>a.name).join(', ')}.`,usedBy:usadas.map(a=>a.name)});
  // Automation.listId é opcional com onDelete: SetNull — as automações ficam sem linha e seguem funcionando.
  await prisma.productList.delete({where:{id:list.id}}); res.json({ok:true,detached:usadas.length});
}));

app.delete('/api/lists/:id/products/:productId', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const list=await prisma.productList.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!list)return res.status(404).json({error:'Lista não encontrada.'});
  await prisma.listProduct.deleteMany({where:{listId:list.id,productId:req.params.productId}}); res.json({ok:true});
}));

app.delete('/api/products/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const prod=await prisma.product.findFirst({where:{id:req.params.id,account:{userId:req.user.id}}}); if(!prod)return res.status(404).json({error:'Produto não encontrado.'});
  await prisma.product.delete({where:{id:prod.id}}); res.json({ok:true});
}));

app.patch('/api/channels/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({name:z.string().min(2).optional(),destination:z.string().min(2).optional(),enabled:z.boolean().optional()}).parse(req.body);
  const ch=await prisma.channel.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!ch)return res.status(404).json({error:'Canal não encontrado.'});
  res.json(await prisma.channel.update({where:{id:ch.id},data:body}));
}));

app.delete('/api/channels/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const ch=await prisma.channel.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!ch)return res.status(404).json({error:'Canal não encontrado.'});
  await prisma.channel.delete({where:{id:ch.id}}); res.json({ok:true});
}));

app.delete('/api/automations/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const a=await prisma.automation.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!a)return res.status(404).json({error:'Automação não encontrada.'});
  await prisma.automation.delete({where:{id:a.id}}); res.json({ok:true});
}));

app.get('/api/products', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const rows=await prisma.product.findMany({where:{account:{userId:req.user.id}},include:{lists:{include:{list:{select:{id:true,name:true}}}}},orderBy:{createdAt:'desc'}});
  // Quantas vezes cada produto já saiu e quando foi o último envio.
  const sent=rows.length?await prisma.promotionJob.groupBy({by:['productId'],where:{productId:{in:rows.map(r=>r.id)},status:'SENT'},_count:{_all:true},_max:{sentAt:true}}):[];
  const sentMap=new Map(sent.map(s=>[s.productId,s]));
  // Mesmo título em anúncios diferentes (IDs diferentes): o robô trata como o mesmo produto.
  const keys=rows.map(r=>titleKey(r.title));const keyCount=new Map<string,number>();
  for(const k of keys) if(k) keyCount.set(k,(keyCount.get(k)||0)+1);
  // "linhas" = listas a que o produto pertence (cada automação com busca Shopee tem a sua).
  res.json(rows.map(({lists,...p},i)=>{const s=sentMap.get(p.id);const k=keys[i];return {...p,lines:lists.map(l=>l.list),sentCount:s?._count._all||0,lastSentAt:s?._max.sentAt||null,titleKey:k,sameTitleCount:k?(keyCount.get(k)||1)-1:0}}));
}));
app.post('/api/products/bulk-delete', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({ids:z.array(z.string()).min(1).max(500)}).parse(req.body);
  const r=await prisma.product.deleteMany({where:{id:{in:body.ids},account:{userId:req.user.id}}});
  res.json({deleted:r.count});
}));
app.post('/api/products/import/manual', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({marketplace:z.enum(MARKETPLACE_LIST),title:z.string().min(2),productUrl:httpUrl(),affiliateUrl:httpUrl(),imageUrl:httpUrl().optional(),price:brNumber,oldPrice:brNumber,discountPercent:z.coerce.number().int().optional(),couponText:z.string().optional(),videoUrl:httpUrl().optional()}).parse(req.body);
  // Cadastro manual não passa por OAuth: o link de afiliado já vem pronto do painel do
  // marketplace. A conta local existe só para agrupar os produtos do usuário.
  const account=await prisma.affiliateAccount.upsert({
    where:{userId_marketplace:{userId:req.user.id,marketplace:body.marketplace}},
    create:{userId:req.user.id,marketplace:body.marketplace,displayName:{SHOPEE:'Shopee',MERCADO_LIVRE:'Mercado Livre',AMAZON:'Amazon'}[body.marketplace]+' (cadastro manual)'},
    update:{}
  });
  res.status(201).json(await prisma.product.create({data:{...body,accountId:account.id}}));
}));

app.post('/api/products/import/mercadolivre', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({url:httpUrl(),affiliateUrl:httpUrl()}).parse(req.body);
  const id=extractMercadoLivreItemId(body.url); if(!id)return res.status(400).json({error:'Não foi possível identificar o ID MLB da URL.'});
  const account=await prisma.affiliateAccount.findUnique({where:{userId_marketplace:{userId:req.user.id,marketplace:'MERCADO_LIVRE'}}});
  if(!account)return res.status(400).json({error:'Conta Mercado Livre não configurada.'});
  // A API do ML exige token: usa o da conta conectada, renovando na hora se estiver vencido.
  let token:string|undefined; try{ token=await getMercadoLivreAccessToken(req.user.id); }catch{ token=undefined; }
  const item=await fetchMercadoLivreItem(id, token);
  const product=await prisma.product.upsert({where:{id:'never'},create:{...item,affiliateUrl:body.affiliateUrl,accountId:account.id,marketplace:'MERCADO_LIVRE'},update:{}}).catch(async()=>prisma.product.create({data:{...item,affiliateUrl:body.affiliateUrl,accountId:account.id,marketplace:'MERCADO_LIVRE'}}));
  res.status(201).json(product);
}));

// Link da Amazon (inteiro ou amzn.to): troca o rastreio pela tag do usuário. Com a Creators API liberada,
// nome, foto e preço vêm da Amazon; sem ela, valem os dados digitados na tela.
app.post('/api/products/import/amazon', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({url:httpUrl(),title:z.string().trim().optional(),imageUrl:httpUrl().optional(),price:brNumber,oldPrice:brNumber,couponText:z.string().optional()}).parse(req.body);
  if(!isAmazonUrl(body.url)) return res.status(400).json({error:'Esse link não é da Amazon.'});
  const tag=await amazonTag(); if(!tag) return res.status(400).json({error:'Salve sua tag de associado da Amazon (ex.: seunome-20) em Configurações antes de importar.'});
  const url=await expandAmazonUrl(body.url); const asin=extractAsin(url);
  let item=null as Awaited<ReturnType<typeof fetchAmazonItem>>;
  if(asin){ try{ item=await fetchAmazonItem(asin); }catch{ item=null; } }
  const title=item?.title||body.title; if(!title) return res.status(400).json({error:'Informe o nome do produto (a busca automática da Amazon ainda não está liberada para sua conta).'});
  const price=item?.price??body.price; const oldPrice=item?.oldPrice??body.oldPrice;
  const account=await prisma.affiliateAccount.upsert({where:{userId_marketplace:{userId:req.user.id,marketplace:'AMAZON'}},create:{userId:req.user.id,marketplace:'AMAZON',displayName:'Amazon Associados'},update:{}});
  const data={title,imageUrl:item?.imageUrl||body.imageUrl||null,productUrl:asin?`https://www.amazon.com.br/dp/${asin}`:url,affiliateUrl:amazonAffiliateUrl(url,tag),price:price??null,oldPrice:oldPrice??null,
    discountPercent:item?.discountPercent??(price&&oldPrice&&oldPrice>price?Math.round((1-price/oldPrice)*100):null),couponText:body.couponText||null,active:true};
  const existing=asin?await prisma.product.findFirst({where:{accountId:account.id,externalId:asin}}):null;
  const product=existing?await prisma.product.update({where:{id:existing.id},data}):await prisma.product.create({data:{...data,accountId:account.id,marketplace:'AMAZON',externalId:asin}});
  res.status(201).json(product);
}));

app.get('/api/channels', requireAuth, asyncRoute(async(req:any,res:any)=>res.json(await prisma.channel.findMany({where:{userId:req.user.id},orderBy:{createdAt:'desc'}}))));
app.post('/api/channels', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({type:z.enum(['WHATSAPP','WHATSAPP_GROUP','INSTAGRAM']),name:z.string().min(2),destination:z.string().min(2),configJson:z.any().optional()}).parse(req.body);
  res.status(201).json(await prisma.channel.create({data:{...body,userId:req.user.id}}));
}));

app.get('/api/automations', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const list=await prisma.automation.findMany({where:{userId:req.user.id},include:{list:true,_count:{select:{jobs:true}}},orderBy:{updatedAt:'desc'}});
  // Último disparo do agendador, para a tela mostrar "agendada · último às 10:30".
  const lastRuns=await prisma.automationLog.findMany({where:{automationId:{in:list.map(a=>a.id)},action:'RUN'},orderBy:{createdAt:'desc'},distinct:['automationId'],select:{automationId:true,createdAt:true,status:true,message:true}});
  res.json(list.map(a=>({...a,scheduleText:describeSchedule(a.scheduleJson as any),lastRun:lastRuns.find(r=>r.automationId===a.id)||null})));
}));
app.post('/api/automations', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({name:z.string().min(2),description:z.string().optional(),template:z.string().min(2),scheduleJson:z.any().optional(),rulesJson:z.any().optional(),listId:z.string().optional(),timezone:z.string().default('America/Sao_Paulo')}).parse(req.body);
  if(body.listId && !(await prisma.productList.findFirst({where:{id:body.listId,userId:req.user.id}}))) return res.status(400).json({error:'Lista inválida.'});
  // Automação com busca na Shopee ganha a própria "linha" de produtos: o que ela encontrar
  // fica separado das outras automações e pode ser filtrado/excluído em bloco na tela Produtos.
  const search=(body.rulesJson as any)?.shopeeSearch;
  if(!body.listId && search && hasShopeeSearch(body.rulesJson)){
    const lineName=body.name;
    const existing=await prisma.productList.findFirst({where:{userId:req.user.id,name:lineName}});
    const line=existing||await prisma.productList.create({data:{userId:req.user.id,name:lineName,description:`Linha da automação "${body.name}" (${describeSearch(search)})`}});
    body.listId=line.id;
  }
  res.status(201).json(await prisma.automation.create({data:{...body,userId:req.user.id}}));
}));
app.patch('/api/automations/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({name:z.string().min(2).optional(),description:z.string().optional(),template:z.string().min(2).optional(),scheduleJson:z.any().optional(),rulesJson:z.any().optional(),listId:z.string().nullable().optional(),status:z.enum(['DRAFT','ACTIVE','PAUSED']).optional()}).parse(req.body);
  const found=await prisma.automation.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!found)return res.status(404).json({error:'Automação não encontrada.'});
  if(body.listId && !(await prisma.productList.findFirst({where:{id:body.listId,userId:req.user.id}}))) return res.status(400).json({error:'Linha inválida.'});
  // Edição que liga busca na Shopee sem linha: cria a linha própria, como na criação.
  const search=(body.rulesJson as any)?.shopeeSearch;
  if(body.listId===null && search && hasShopeeSearch(body.rulesJson)){
    const lineName=body.name||found.name;
    const line=await prisma.productList.findFirst({where:{userId:req.user.id,name:lineName}})||await prisma.productList.create({data:{userId:req.user.id,name:lineName,description:`Linha da automação "${lineName}" (${describeSearch(search)})`}});
    body.listId=line.id;
  }
  res.json(await prisma.automation.update({where:{id:found.id},data:body}));
}));

app.post('/api/automations/:id/generate-jobs', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const a=await prisma.automation.findFirst({where:{id:req.params.id,userId:req.user.id},select:{id:true}}); if(!a)return res.status(404).json({error:'Automação não encontrada.'});
  // Disparo manual é um teste: manda UM produto (sem repetir), nunca a lista inteira.
  try{ const r=await runAutomation(a.id,{source:'manual',perRun:1}); res.json({count:r.jobs,products:r.products,skipped:r.skipped,message:r.message}); }
  catch(e:any){ res.status(400).json({error:e.message}); }
}));

// ---------- Backup ----------
const requireAdmin=(req:any,res:any)=>{ if(!['MASTER','ADMIN'].includes(req.user.role)){ res.status(403).json({error:'Somente administradores.'}); return false; } return true; };
app.get('/api/backups', requireAuth, asyncRoute(async(req:any,res:any)=>{ if(!requireAdmin(req,res))return; res.json({dir:BACKUP_DIR,backups:listBackups()}); }));
app.post('/api/backups', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  try{ res.status(201).json(await createBackup('manual')); }catch(e:any){ res.status(500).json({error:e.message}); }
}));
app.get('/api/backups/:file', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  try{ res.download(backupPath(req.params.file)); }catch(e:any){ res.status(404).json({error:e.message}); }
}));
app.delete('/api/backups/:file', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  try{ deleteBackup(req.params.file); res.json({ok:true}); }catch(e:any){ res.status(404).json({error:e.message}); }
}));

// Vendas e comissões reais (Shopee via conversionReport) para o Dashboard.
app.get('/api/reports/sales', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const period=(['today','7d','30d','month','prev_month'] as const).includes(req.query.period)?req.query.period:'30d';
  if(req.query.refresh==='1') clearSalesCache();
  res.json(await salesReport(period));
}));

// Prévia da busca usada pelo assistente de automação: mostra foto, comissão e vendas antes de salvar.
// Serve Shopee e Mercado Livre (campo marketplace).
// Termos mais buscados no Mercado Livre (site inteiro ou de uma categoria). Serve de sugestão de palavras-chave
// para automações de qualquer marketplace: o que o brasileiro procura no ML, procura na Shopee também.
app.get('/api/mercadolivre/trends', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const categoryId=typeof req.query.categoryId==='string'&&/^MLB\d+$/i.test(req.query.categoryId)?req.query.categoryId.toUpperCase():undefined;
  try{ res.json({keywords:await trendingKeywords(req.user.id,categoryId)}); }catch(e:any){ res.status(400).json({error:e.message}); }
}));
// Campo "Digite um nicho" da busca automática: "infantil" -> todas as categorias do ML ligadas a isso, com subcategorias.
app.get('/api/categories/search', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const q=z.object({q:z.string().trim().min(2).max(80)}).parse(req.query);
  try{ res.json(await searchCategories(q.q)); }catch(e:any){ res.status(400).json({error:e.message}); }
}));
app.post('/api/shopee/search', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({marketplace:z.enum(MARKETPLACE_LIST).optional(),marketplaces:z.array(z.enum(MARKETPLACE_LIST)).max(3).optional(),keyword:z.string().optional(),keywords:z.array(z.string()).max(50).optional(),categoryId:z.union([z.string(),z.number()]).optional(),sort:z.enum(['SALES','COMMISSION','RELEVANCE','BOTH','TRENDING']).optional(),sorts:z.array(z.enum(['SALES','COMMISSION','RELEVANCE','BOTH','TRENDING','DEALS','BUYERS'])).max(7).optional(),limit:z.coerce.number().int().min(1).max(50).optional(),minDiscount:z.coerce.number().int().min(0).max(99).optional()}).parse(req.body);
  try{ res.json({offers:await searchOffers(req.user.id,{...body,categoryId:body.categoryId===''?undefined:body.categoryId})}); }
  catch(e:any){ res.status(400).json({error:e.message}); }
}));

app.post('/api/promotions/queue', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({automationId:z.string(),productId:z.string().optional(),channelId:z.string(),scheduledAt:z.coerce.date(),payload:z.object({title:z.string(),text:z.string(),affiliateUrl:httpUrl(),imageUrl:httpUrl().optional()})}).parse(req.body);
  const owned=await prisma.automation.findFirst({where:{id:body.automationId,userId:req.user.id}}); if(!owned)return res.status(404).json({error:'Automação inválida.'});
  if(!(await prisma.channel.findFirst({where:{id:body.channelId,userId:req.user.id}}))) return res.status(404).json({error:'Canal inválido.'});
  if(body.productId && !(await prisma.product.findFirst({where:{id:body.productId,account:{userId:req.user.id}}}))) return res.status(404).json({error:'Produto inválido.'});
  const job=await prisma.promotionJob.create({data:{automationId:body.automationId,productId:body.productId,channelId:body.channelId,scheduledAt:body.scheduledAt,payloadJson:body.payload}});
  res.status(201).json(job); // a linha PENDING com scheduledAt já é a fila: o worker pega quando vencer
}));

app.get('/api/logs', requireAuth, asyncRoute(async(req:any,res:any)=>res.json(await prisma.automationLog.findMany({where:{automation:{userId:req.user.id}},orderBy:{createdAt:'desc'},take:200}))));

// Envios (um por produto × grupo) para a tela Envios: o que saiu, para onde, quando e com que resultado.
app.get('/api/sends', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const q=z.object({days:z.coerce.number().int().min(1).max(90).default(7),channelId:z.string().optional(),automationId:z.string().optional(),status:z.enum(['PENDING','PROCESSING','SENT','FAILED']).optional(),search:z.string().optional()}).parse(req.query);
  const since=new Date(Date.now()-q.days*86400000);
  const rows=await prisma.promotionJob.findMany({
    where:{automation:{userId:req.user.id},createdAt:{gte:since},...(q.channelId?{channelId:q.channelId}:{}),...(q.automationId?{automationId:q.automationId}:{}),...(q.status?{status:q.status}:{})},
    orderBy:{createdAt:'desc'},take:1000,
    select:{id:true,status:true,attempts:true,errorMessage:true,createdAt:true,sentAt:true,payloadJson:true,product:{select:{title:true,marketplace:true,affiliateUrl:true,imageUrl:true,price:true}},channel:{select:{id:true,name:true}},automation:{select:{id:true,name:true}}}
  });
  const search=(q.search||'').trim().toLowerCase();
  const sends=rows.map(r=>{const p:any=r.payloadJson||{};const title=r.product?.title||p.title||'(sem título)';return {id:r.id,status:r.status,attempts:r.attempts,error:r.errorMessage,createdAt:r.createdAt,sentAt:r.sentAt,title,marketplace:r.product?.marketplace||null,price:r.product?.price!=null?Number(r.product.price):null,imageUrl:r.product?.imageUrl||p.imageUrl||null,affiliateUrl:r.product?.affiliateUrl||p.affiliateUrl||null,productDeleted:!r.product&&!/^Cupons /.test(String(p.title||'')),channel:r.channel,automation:r.automation}})
    .filter(s=>!search||s.title.toLowerCase().includes(search));
  const channels=await prisma.channel.findMany({where:{userId:req.user.id},select:{id:true,name:true},orderBy:{name:'asc'}});
  const automations=await prisma.automation.findMany({where:{userId:req.user.id},select:{id:true,name:true},orderBy:{name:'asc'}});
  res.json({sends,channels,automations});
}));
app.post('/api/offers/preview', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({productId:z.string(),template:z.string().optional()}).parse(req.body); const p=await prisma.product.findFirst({where:{id:body.productId,account:{userId:req.user.id}}}); if(!p)return res.status(404).json({error:'Produto não encontrado.'});
  const coupons=await productCoupons(req.user.id);
  res.json({text:renderOffer(body.template||defaultOfferTemplate(),{title:p.title,price:p.price?Number(p.price):undefined,oldPrice:p.oldPrice?Number(p.oldPrice):undefined,discountPercent:p.discountPercent||undefined,couponText:p.couponText||pickCoupon(coupons,p),affiliateUrl:p.affiliateUrl})});
}));

// ---------- Cupons (Shopee / Mercado Livre) ----------
const couponBody=z.object({
  marketplace:z.enum(MARKETPLACE_LIST),
  code:z.string().trim().min(3).max(40),
  description:z.string().trim().max(200).optional().nullable(),
  minPrice:brNumber,
  validUntil:z.string().optional().nullable(),
  inProducts:z.boolean().optional(),
  enabled:z.boolean().optional()
});
const scheduleBody=z.object({
  enabled:z.boolean().optional(),
  everyMinutes:z.coerce.number().int().min(0).max(1440).optional(),
  startTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),
  channelIds:z.array(z.string()).optional(),
  link:z.string().trim().url().or(z.literal('')).optional().nullable(),
  telegramChannel:z.string().trim().max(80).optional().nullable()
});
const couponView=(c:any)=>({...c,minPrice:c.minPrice!=null?Number(c.minPrice):null,expired:isExpired(c)});
async function couponsPayload(userId:string){
  const coupons=(await prisma.coupon.findMany({where:{userId},orderBy:[{marketplace:'asc'},{createdAt:'asc'}]})).map(couponView);
  const schedules:any={};
  for(const m of MARKETPLACES){
    const sch=await getSchedule(userId,m);
    const usable=coupons.filter((c:any)=>c.marketplace===m&&c.enabled&&!c.expired);
    const groups=(await scheduleChannels(sch)).map(ch=>({id:ch.id,name:ch.name}));
    schedules[m]={...sch,usable:usable.length,groups,text:couponListMessage(m,usable,sch.link),next:describeSchedule({everyMinutes:sch.everyMinutes,startTime:sch.startTime,endTime:sch.endTime})};
  }
  return {coupons,schedules};
}
app.get('/api/coupons', requireAuth, asyncRoute(async(req:any,res:any)=>res.json(await couponsPayload(req.user.id))));
app.post('/api/coupons', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=couponBody.parse(req.body);
  const c=await prisma.coupon.create({data:{userId:req.user.id,marketplace:body.marketplace,code:body.code.toUpperCase(),description:body.description||null,minPrice:body.minPrice??null,validUntil:parseValidUntil(body.validUntil),inProducts:body.inProducts??false,enabled:body.enabled??true}});
  res.status(201).json(couponView(c));
}));
// Lê cupons de um texto colado (lista do Telegram, mensagem de grupo) sem salvar.
app.post('/api/coupons/parse', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({text:z.string().min(3).max(20000)}).parse(req.body);
  res.json(parseCouponText(body.text));
}));
// Salva vários de uma vez (resultado do "colar lista"). Código repetido no mesmo marketplace é ignorado.
app.post('/api/coupons/bulk', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({marketplace:z.enum(MARKETPLACE_LIST),validUntil:z.string().optional().nullable(),inProducts:z.boolean().optional(),items:z.array(z.object({code:z.string().trim().min(3).max(40),description:z.string().trim().max(200).optional().nullable(),minPrice:brNumber})).min(1).max(100)}).parse(req.body);
  const existing=new Set((await prisma.coupon.findMany({where:{userId:req.user.id,marketplace:body.marketplace},select:{code:true}})).map(c=>c.code));
  let count=0;
  for(const it of body.items){ const code=it.code.toUpperCase(); if(existing.has(code)) continue; existing.add(code);
    await prisma.coupon.create({data:{userId:req.user.id,marketplace:body.marketplace,code,description:it.description||null,minPrice:it.minPrice??null,validUntil:parseValidUntil(body.validUntil),inProducts:body.inProducts??false}}); count++; }
  res.status(201).json({count,skipped:body.items.length-count});
}));
app.patch('/api/coupons/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const c=await prisma.coupon.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cupom não encontrado.'});
  const body=couponBody.partial().parse(req.body);
  const data:any={};
  for(const k of ['marketplace','inProducts','enabled'] as const) if(body[k]!==undefined) data[k]=body[k];
  if(body.code!==undefined) data.code=body.code.toUpperCase();
  if('description' in body) data.description=body.description||null;
  if('minPrice' in body) data.minPrice=body.minPrice??null;
  if('validUntil' in body) data.validUntil=parseValidUntil(body.validUntil);
  res.json(couponView(await prisma.coupon.update({where:{id:c.id},data})));
}));
app.delete('/api/coupons/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const c=await prisma.coupon.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cupom não encontrado.'});
  await prisma.coupon.delete({where:{id:c.id}}); res.json({ok:true});
}));
// Agenda do listão por marketplace (intervalo, janela, grupos, link do usuário, canal do Telegram).
app.put('/api/coupons/schedule/:marketplace', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const m=z.enum(MARKETPLACE_LIST).parse(req.params.marketplace); const body=scheduleBody.parse(req.body);
  const sch=await getSchedule(req.user.id,m);
  const data:any={...body}; if('link' in body) data.link=body.link||null; if('telegramChannel' in body) data.telegramChannel=body.telegramChannel?body.telegramChannel.replace(/^@/,''):null;
  await prisma.couponSchedule.update({where:{id:sch.id},data});
  res.json(await couponsPayload(req.user.id));
}));
// Importa agora os cupons do canal do Telegram configurado (ou informado no corpo).
app.post('/api/coupons/import-telegram/:marketplace', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const m=z.enum(MARKETPLACE_LIST).parse(req.params.marketplace);
  const sch=await getSchedule(req.user.id,m); const channel=String(req.body?.channel||sch.telegramChannel||'').trim();
  if(!channel) return res.status(400).json({error:'Informe o canal público do Telegram (ex.: melicupons).'});
  try{ const r=await importTelegramCoupons(req.user.id,m,channel); res.json({...r,...(await couponsPayload(req.user.id))}); }catch(e:any){ res.status(400).json({error:e.message}); }
}));
// Envia o listão agora.
app.post('/api/coupons/send/:marketplace', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const m=z.enum(MARKETPLACE_LIST).parse(req.params.marketplace);
  const sch=await getSchedule(req.user.id,m);
  try{ const n=await sendCouponList(sch,'manual'); res.json({count:n}); }catch(e:any){ res.status(400).json({error:e.message}); }
}));

// ---------- WhatsApp Web (grupos) ----------
// Vários números (pedido do usuário em 2026-10-08): cada um tem o seu QR code; "principal" é o de sempre.
// O QR só vai para quem pode gerenciar usuários.
app.get('/api/whatsapp/status', requireAuth, (req:any,res:any)=>{ const admin=canManageUsers(req.user); res.json({sessions:listWaSessions().map(s=>({...s,qr:admin?s.qr:null}))}); });
const SESSION_ID=z.string().regex(/^(principal|nd{1,3})$/);
// Número escolhido para adicionar no grupo (pedido do usuário em 2026-10-08): precisa estar conectado e no grupo.
function checkVia(via:string,groupId:string){
  const st=listWaSessions().find(s=>s.id===via);
  if(!st) return 'Esse número não está mais conectado. Escolha outro.';
  if(st.status!=='connected') return `O número +${st.me?.id||via} não está conectado agora. Escolha outro ou espere ele voltar.`;
  if(!waGroupSessions(groupId).includes(via)) return `O número +${st.me?.id} não está nesse grupo. Escolha um número que seja membro (de preferência administrador).`;
  return null;
}
const sessionBody=(req:any)=>z.object({session:z.string().regex(/^(principal|nd{1,3})$/).default('principal')}).parse(req.body||{}).session;

app.post('/api/whatsapp/connect', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const id=sessionBody(req);
  connectWhatsAppWeb(id).catch(()=>{});
  // O QR leva ~1-3s para chegar; a tela consulta /status até aparecer.
  res.json(getWaState(id));
}));

// Mais um número: cria a sessão e já começa a gerar o QR code dele.
app.post('/api/whatsapp/sessions', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  // No máximo 4 contas (pedido do usuário em 2026-10-08): a principal e mais 3.
  if(listWaSessions().length>=4) return res.status(409).json({error:'Já são 4 números, o máximo. Desconecte algum antes de adicionar outro.'});
  res.status(201).json(getWaState(addWaSession()));
}));

app.post('/api/whatsapp/logout', requireAuth, asyncRoute(async(req:any,res:any)=>{ if(!requireAdmin(req,res))return; await logoutWhatsAppWeb(sessionBody(req)); res.json({ok:true}); }));

app.get('/api/whatsapp/groups', requireAuth, asyncRoute(async(_req:any,res:any)=>{
  try{ res.json(await listGroups()); }catch(e:any){ res.status(409).json({error:e.message}); }
}));

// Contatos de um grupo (para baixar em planilha).
app.get('/api/whatsapp/groups/:id/members', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  try{ res.json(await listGroupMembers(String(req.params.id))); }catch(e:any){ res.status(409).json({error:e.message}); }
}));

// Importação de contatos de um grupo para outro. Roda em segundo plano, em lotes pequenos
// e com pausa entre eles: adicionar muita gente de uma vez é o jeito mais rápido de o número ser bloqueado.
type GroupInvite={total:number;sent:number;failed:string[];running:boolean;error:string|null};
type GroupCopy={fromName:string;toId:string;toName:string;invite:GroupInvite|null;autoInvite:boolean;batch:number;pauseSec:number;dailyLimit:number;waitingUntil:string|null;waitingConnection:boolean;warmingUntil?:string|null;stopped:boolean;total:number;done:number;added:number;already:number;privacy:string[];failed:string[];failReasons:Record<string,string>;skippedBefore:number;noPhone:number;running:boolean;error:string|null;startedAt:string;finishedAt:string|null;session?:string|null;sessionPhone?:string|null;tempContacts?:boolean};
// Uma importação por grupo de destino (pedido do usuário em 2026-10-06): começar outra para um grupo diferente
// não pode apagar a que estava pela metade. Quem falta (rest) fica fora do job para não ir inteiro para a tela.
type CopyEntry={job:GroupCopy;rest:string[];inviteText?:string};
const groupCopies=new Map<string,CopyEntry>();
// Ficam em disco para sobreviver a um reinício do sistema (senão as pessoas que faltavam se perdiam).
const COPIES_FILE=path.resolve(__dirname,'../.cache/group-copies.json');
function saveCopies(){
  try{ fs.mkdirSync(path.dirname(COPIES_FILE),{recursive:true}); fs.writeFileSync(COPIES_FILE,JSON.stringify([...groupCopies.values()])); }catch{}
}

// Limite de pessoas adicionadas por dia (pedido do usuário em 2026-10-04). A contagem soma todas as
// importações do dia e fica em disco, para valer mesmo se o sistema reiniciar. Tentativa conta
// (mesmo quem não entrou por privacidade), porque o que o WhatsApp vigia é o pedido de adicionar.
// Com vários números (2026-10-08) cada um tem a sua contagem: um número no limite não segura a importação dos outros.
const ADD_COUNT_FILE=path.resolve(__dirname,'../.cache/group-adds.json');
const spDay=(d=new Date())=>d.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
function readAdds():Record<string,number>{
  try{
    const j=JSON.parse(fs.readFileSync(ADD_COUNT_FILE,'utf8'));
    if(j.day!==spDay()) return {};
    return j.by||{principal:Number(j.count)||0}; // arquivo antigo: tudo era do número principal
  }catch{ return {}; }
}
/** Quantas pessoas o número adicionou hoje (sem número: a soma de todos, para a tela). */
function addsToday(session?:string):number{
  const by=readAdds();
  return session?by[session]||0:Object.values(by).reduce((a,b)=>a+b,0);
}
function countAdds(n:number,session:string){
  const by=readAdds(); by[session]=(by[session]||0)+n;
  try{ fs.mkdirSync(path.dirname(ADD_COUNT_FILE),{recursive:true}); fs.writeFileSync(ADD_COUNT_FILE,JSON.stringify({day:spDay(),count:Object.values(by).reduce((a,b)=>a+b,0),by})); }catch{}
}
// Quem o sistema já adicionou em cada grupo (pedido do usuário em 2026-10-05): numa nova importação
// essas pessoas são puladas, mesmo que tenham saído do grupo — adicionar de novo quem saiu é o que mais gera denúncia.
const ADDED_FILE=path.resolve(__dirname,'../.cache/group-added.json');
function readAdded():Record<string,string[]>{ try{ return JSON.parse(fs.readFileSync(ADDED_FILE,'utf8'))||{}; }catch{ return {}; } }
function addedBefore(groupId:string){ return new Set(readAdded()[groupId]||[]); }
function rememberAdded(groupId:string,phones:string[]){
  if(!phones.length) return;
  try{ const all=readAdded(); all[groupId]=[...new Set([...(all[groupId]||[]),...phones])]; fs.mkdirSync(path.dirname(ADDED_FILE),{recursive:true}); fs.writeFileSync(ADDED_FILE,JSON.stringify(all)); }catch{}
}
/** Embaralha uma cópia da lista (Fisher-Yates). */
function shuffle<T>(list:T[]){ const a=[...list]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/** Meia-noite de amanhã no horário de Brasília (o Brasil não tem horário de verão desde 2019: UTC-3). */
function nextSpMidnight(){ const [y,m,d]=spDay().split('-').map(Number); return new Date(Date.UTC(y,m-1,d+1,3,0,5)); }

// O que a tela recebe: todas as importações (a mais nova primeiro), quantos ainda faltam em cada uma (left) e quantos já entraram hoje.
const entryPayload=(e:CopyEntry)=>({...e.job,left:e.rest.length});
const copyPayload=()=>({addedToday:addsToday(),jobs:[...groupCopies.values()].sort((a,b)=>b.job.startedAt.localeCompare(a.job.startedAt)).map(entryPayload)});
/** A importação do grupo de destino que a tela mandou (campo "to"), ou responde o erro. */
function copyEntry(req:any,res:any){
  const e=groupCopies.get(String(req.body?.to||req.params?.to||''));
  if(!e) res.status(404).json({error:'Não achei essa importação. Atualize a página.'});
  return e;
}
app.get('/api/whatsapp/groups/copy', requireAuth, (req:any,res:any)=>{ if(!requireAdmin(req,res))return; res.json(copyPayload()); });
// Para a importação em andamento (o lote que está saindo termina; nada mais é adicionado).
app.post('/api/whatsapp/groups/copy/stop', requireAuth, (req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const e=copyEntry(req,res); if(!e)return;
  if(!e.job.running) return res.status(409).json({error:'Essa importação não está rodando.'});
  e.job.stopped=true; saveCopies(); res.json(copyPayload());
});
// Muda o limite por dia (e, se vier, o ritmo) da importação em andamento (pedido do usuário em 2026-10-05).
// Se ela estava esperando a meia-noite e o novo limite deixa espaço, volta a adicionar na hora.
app.post('/api/whatsapp/groups/copy/settings', requireAuth, (req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const body=z.object({batch:z.coerce.number().int().min(1).max(20).optional(),pauseSec:z.coerce.number().int().min(10).max(3600).optional(),dailyLimit:z.coerce.number().int().min(1).max(1000)}).parse(req.body);
  const e=copyEntry(req,res); if(!e)return;
  if(!e.job.running||e.job.stopped) return res.status(409).json({error:'Essa importação não está rodando.'});
  Object.assign(e.job,{dailyLimit:body.dailyLimit,...(body.batch?{batch:body.batch}:{}),...(body.pauseSec?{pauseSec:body.pauseSec}:{})});
  saveCopies(); res.json(copyPayload());
});
// Continua de onde parou uma importação parada (pela pessoa ou por erro), podendo trocar limite e ritmo.
app.post('/api/whatsapp/groups/copy/resume', requireAuth, (req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const body=z.object({batch:z.coerce.number().int().min(1).max(20).optional(),pauseSec:z.coerce.number().int().min(10).max(3600).optional(),dailyLimit:z.coerce.number().int().min(1).max(1000),session:SESSION_ID.optional()}).parse(req.body);
  const e=copyEntry(req,res); if(!e)return;
  const job=e.job;
  if(job.running) return res.status(409).json({error:'Essa importação ainda está rodando.'});
  if(body.session&&body.session!==job.session){
    const bad=checkVia(body.session,job.toId); if(bad) return res.status(409).json({error:bad});
    job.session=body.session; job.sessionPhone=getWaState(body.session).me?.id||null;
  }
  if(job.invite?.running) return res.status(409).json({error:'Espere os convites terminarem de sair.'});
  if(!e.rest.length) return res.status(409).json({error:'Não falta ninguém para adicionar nessa importação.'});
  Object.assign(job,{dailyLimit:body.dailyLimit,...(body.batch?{batch:body.batch}:{}),...(body.pauseSec?{pauseSec:body.pauseSec}:{}),stopped:false,error:null,finishedAt:null,running:true});
  runGroupCopy(e);
  res.status(202).json(copyPayload());
});
// Tira da tela uma importação que não está rodando. Quem ela já adicionou continua sendo pulado nas próximas.
app.delete('/api/whatsapp/groups/copy/:to', requireAuth, (req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const e=copyEntry(req,res); if(!e)return;
  if(e.job.running||e.job.invite?.running) return res.status(409).json({error:'Pare a importação antes de tirar da lista.'});
  groupCopies.delete(e.job.toId); saveCopies(); res.json(copyPayload());
});
app.post('/api/whatsapp/groups/copy', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  // Quantas pessoas por vez e quanto esperar entre os lotes: quem importa escolhe (padrão 5 a cada 30s).
  // A origem é outro grupo (from) ou uma lista de telefones vinda de planilha (phones).
  const body=z.object({from:z.string().endsWith('@g.us').optional(),phones:z.array(z.string().regex(/^\d{10,15}$/)).min(1).max(5000).optional(),fileName:z.string().max(200).optional(),to:z.string().endsWith('@g.us'),batch:z.coerce.number().int().min(1).max(20).default(5),pauseSec:z.coerce.number().int().min(10).max(3600).default(30),dailyLimit:z.coerce.number().int().min(1).max(1000).default(50),inviteText:z.string().trim().min(1).max(1000).refine(t=>t.includes('{link}'),'A mensagem do convite precisa ter {link} no lugar do link do grupo.').optional(),session:SESSION_ID.optional(),tempContacts:z.boolean().default(true)}).parse(req.body);
  if(!body.from&&!body.phones) return res.status(400).json({error:'Escolha o grupo de origem ou um arquivo com os telefones.'});
  if(body.from===body.to) return res.status(400).json({error:'Escolha grupos diferentes.'});
  // Outros grupos podem estar importando ao mesmo tempo; só o mesmo destino é que não pode ter duas.
  const old=groupCopies.get(body.to);
  if(old?.job.running) return res.status(409).json({error:`Já existe uma importação rodando para "${old.job.toName}". Pare ela antes ou escolha outro grupo.`});
  if(old?.job.invite?.running) return res.status(409).json({error:`Os convites da importação de "${old.job.toName}" ainda estão saindo. Espere terminar.`});
  let srcName:string, srcPhones:string[], noPhone=0, dst;
  try{
    if(body.session){ const bad=checkVia(body.session,body.to); if(bad) return res.status(409).json({error:bad}); }
    dst=await listGroupMembers(body.to,body.session);
    if(body.from){
      const src=await listGroupMembers(body.from);
      // Contatos sem telefone (@lid, grupos com número oculto) não podem ser adicionados.
      srcName=src.name; srcPhones=src.members.filter(m=>m.phone).map(m=>m.phone!); noPhone=src.members.length-srcPhones.length;
    }else{ srcName=`arquivo ${body.fileName||'CSV'}`; srcPhones=[...new Set(body.phones!)]; }
  }catch(e:any){ return res.status(409).json({error:e.message}); }
  const inDest=new Set(dst.members.map(m=>m.phone||m.jid));
  const before=addedBefore(body.to);
  const fresh=srcPhones.filter(p=>!inDest.has(p));
  // Ordem embaralhada: adicionar na sequência exata da planilha é padrão de robô.
  const todo=shuffle(fresh.filter(p=>!before.has(p))).map(p=>`${p}@s.whatsapp.net`);
  const skippedBefore=fresh.length-todo.length;
  const job:GroupCopy={fromName:srcName,toId:body.to,toName:dst.name,invite:null,autoInvite:!!body.inviteText,batch:body.batch,pauseSec:body.pauseSec,dailyLimit:body.dailyLimit,waitingUntil:null,waitingConnection:false,stopped:false,total:todo.length,done:0,added:0,already:srcPhones.length-fresh.length,privacy:[],failed:[],failReasons:{},skippedBefore,noPhone,running:todo.length>0,error:null,startedAt:new Date().toISOString(),finishedAt:todo.length?null:new Date().toISOString(),session:body.session||null,sessionPhone:body.session?getWaState(body.session).me?.id||null:null,tempContacts:body.tempContacts};
  // Uma importação antiga parada para este mesmo destino é substituída: a nova já pula quem a antiga adicionou.
  const entry:CopyEntry={job,rest:todo,inviteText:body.inviteText};
  groupCopies.set(body.to,entry); saveCopies();
  if(todo.length) runGroupCopy(entry);
  res.status(202).json(copyPayload());
}));

const notConnected=(e:any)=>/não conectado/i.test(String(e?.message||e));
// Adicionar gente logo depois de conectar é o que mais faz o WhatsApp remover o aparelho (aconteceu em 2026-10-06:
// QR escaneado, 3 pessoas adicionadas e o aparelho removido segundos depois). Então espera a conexão firmar.
const WARMUP_AFTER_PAIR=60*60_000;     // 1 h depois de escanear um QR code novo
const WARMUP_AFTER_CONNECT=5*60_000;   // 5 min depois de uma reconexão comum
const REMOVED_MSG='O WhatsApp removeu o aparelho enquanto esta importação rodava (sinal de que achou as adições rápidas demais). Pausei por segurança: espere algumas horas e continue com um limite por dia menor.';

/** Adiciona em segundo plano quem falta em entry.rest. Limite do dia, lote e pausa são lidos do job a cada volta, porque podem mudar no meio. */
function runGroupCopy(entry:CopyEntry){
  const job=entry.job;
  const runStarted=Date.now();
  (async()=>{
    try{
      // Espera em fatias curtas para o "Parar" (e a troca do limite) responder logo.
      const wait=async(ms:number,until=()=>false)=>{ const end=Date.now()+ms; while(!job.stopped&&!until()&&Date.now()<end) await new Promise(r=>setTimeout(r,Math.min(5_000,end-Date.now()))); };
      while(entry.rest.length&&!job.stopped&&groupCopies.get(job.toId)===entry){
        // Número que está no grupo de destino: cada número tem a sua conexão e o seu limite do dia.
        // Com número escolhido, só ele adiciona: se ele cair, a importação espera ele voltar (não troca sozinha).
        if(job.session&&!listWaSessions().some(s=>s.id===job.session)) throw new Error(`O número +${job.sessionPhone||job.session} escolhido para esta importação foi desconectado. Continue de onde parou escolhendo outro número.`);
        const waId=job.session||await sessionForJid(job.toId);
        // Bateu o limite do dia: espera a virada do dia (ou a pessoa aumentar o limite) e continua sozinho.
        const room=job.dailyLimit-addsToday(waId);
        if(room<=0){
          job.waitingUntil=nextSpMidnight().toISOString(); saveCopies();
          await wait(new Date(job.waitingUntil).getTime()-Date.now(),()=>job.dailyLimit>addsToday(waId));
          job.waitingUntil=null;
          continue;
        }
        // O WhatsApp removeu o aparelho no meio desta importação: pausa e só volta quando a pessoa mandar.
        const wa=getWaState(waId);
        if(wa.removedAt&&wa.removedAt>runStarted) throw new Error(REMOVED_MSG);
        // WhatsApp caiu: em vez de parar a importação, espera ele voltar e segue de onde estava.
        if(wa.status!=='connected'){
          job.waitingConnection=true;
          await wait(60_000,()=>getWaState(waId).status==='connected');
          continue;
        }
        job.waitingConnection=false;
        // Conectou agora há pouco: espera a conexão firmar antes de adicionar alguém.
        const ready=Math.max((wa.pairedAt||0)+WARMUP_AFTER_PAIR,(wa.connectedAt||0)+WARMUP_AFTER_CONNECT);
        if(Date.now()<ready){
          job.warmingUntil=new Date(ready).toISOString();
          await wait(ready-Date.now(),()=>getWaState(waId).status!=='connected');
          job.warmingUntil=null;
          continue;
        }
        // Lote de tamanho variado (de 1 até o escolhido) para não ter um ritmo certinho de máquina.
        const size=1+Math.floor(Math.random()*job.batch);
        const batch=entry.rest.slice(0,Math.min(size,room));
        entry.rest=entry.rest.slice(batch.length);
        let results;
        try{ results=await addGroupMembers(job.toId,batch,waId,job.tempContacts!==false); }
        catch(e:any){
          // Não chegou a adicionar: o lote volta para a fila.
          entry.rest=[...batch,...entry.rest];
          // Caiu bem na hora de mandar: não conta no limite do dia e espera reconectar (volta do laço).
          if(notConnected(e)){ await wait(5_000); continue; }
          countAdds(batch.length,waId);
          // Sem ser administrador do destino não adianta continuar.
          if(/not-authorized|forbidden/i.test(String(e?.message||e))) throw new Error(`Você precisa ser administrador do grupo "${job.toName}" para adicionar pessoas.`);
          throw e;
        }
        countAdds(batch.length,waId);
        rememberAdded(job.toId,results.filter(r=>r.result==='added'||r.result==='already').map(r=>r.jid.split('@')[0]));
        for(const r of results){
          const phone=r.jid.split('@')[0];
          if(r.result==='added') job.added++;
          else if(r.result==='already') job.already++;
          else if(r.result==='privacy') job.privacy.push(phone);
          else { job.failed.push(phone); job.failReasons[phone]=r.reason||'erro desconhecido'; }
        }
        job.done+=batch.length;
        saveCopies();
        // Pausa variada: entre 70% e 150% do tempo escolhido.
        if(entry.rest.length) await wait(job.pauseSec*1000*(0.7+Math.random()*0.8));
      }
    }catch(e:any){ job.error=e?.message||String(e); }
    finally{
      // Convite automático: ao terminar, manda no privado de quem a privacidade barrou.
      // Se a importação foi parada pela pessoa (ou deu erro e pode continuar), não manda — ela pode mandar pelo botão se quiser.
      // O convite já nasce "running" antes de a importação acabar, para a tela não parar de atualizar no meio.
      if(entry.inviteText&&job.privacy.length&&!job.stopped&&!job.error&&!job.invite) job.invite={total:job.privacy.length,sent:0,failed:[],running:true,error:null};
      job.running=false; job.waitingUntil=null; job.waitingConnection=false; job.warmingUntil=null; job.finishedAt=new Date().toISOString();
      saveCopies();
    }
    if(job.invite?.running){
      const err=await startInvites(job,entry.inviteText!).catch((e:any)=>e?.message||String(e));
      if(err){ job.invite={total:job.privacy.length,sent:0,failed:[],running:false,error:err}; saveCopies(); }
    }
  })();
}

// Ao ligar o sistema: carrega as importações salvas e retoma sozinho as que estavam rodando
// (se o WhatsApp ainda não conectou, elas esperam ele voltar). Convites que estavam saindo não são reenviados
// sozinhos, para ninguém receber a mesma mensagem duas vezes.
(function loadCopies(){
  let saved:CopyEntry[]=[];
  try{ saved=JSON.parse(fs.readFileSync(COPIES_FILE,'utf8'))||[]; }catch{ return; }
  for(const e of saved){
    if(!e?.job?.toId||!Array.isArray(e.rest)) continue;
    e.job.startedAt||=e.job.finishedAt||new Date().toISOString();
    e.job.waitingUntil=null; e.job.waitingConnection=false; e.job.warmingUntil=null;
    if(e.job.invite?.running) e.job.invite={...e.job.invite,running:false,error:'o sistema foi reiniciado no meio do envio.'};
    groupCopies.set(e.job.toId,e);
    if(e.job.running){
      if(e.job.stopped||!e.rest.length){ e.job.running=false; e.job.finishedAt=new Date().toISOString(); }
      else runGroupCopy(e);
    }
  }
})();

// Link de convite do grupo, para mandar a quem não pôde ser adicionado direto.
app.get('/api/whatsapp/groups/:id/invite', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const via=req.query.session?SESSION_ID.parse(req.query.session):undefined;
  try{ res.json({link:await groupInviteLink(String(req.params.id),via)}); }
  catch(e:any){ res.status(409).json({error:/not-authorized|forbidden/i.test(String(e?.message||e))?'Você precisa ser administrador do grupo para pegar o link de convite.':e.message}); }
}));

// Manda o convite no privado de quem a privacidade não deixou adicionar na importação escolhida.
// Um de cada vez, com pausa sorteada entre 25 e 45s: mensagem em massa para quem não tem o número salvo chama atenção do WhatsApp.
app.post('/api/whatsapp/groups/copy/invite', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!requireAdmin(req,res))return;
  const body=z.object({text:z.string().trim().min(1).max(1000).refine(t=>t.includes('{link}'),'A mensagem precisa ter {link} no lugar do link do grupo.')}).parse(req.body);
  const e=copyEntry(req,res); if(!e)return;
  const job=e.job;
  if(job.running) return res.status(409).json({error:'Espere a importação terminar para mandar os convites.'});
  if(job.invite?.running) return res.status(409).json({error:'Os convites já estão sendo enviados.'});
  if(!job.privacy.length) return res.status(400).json({error:'Ninguém ficou de fora por privacidade.'});
  const err=await startInvites(job,body.text);
  if(err) return res.status(409).json({error:err});
  res.status(202).json(copyPayload());
}));

/** Começa a mandar o convite em segundo plano para quem ficou de fora por privacidade. Devolve o erro, se não deu nem para começar. */
async function startInvites(job:GroupCopy,template:string):Promise<string|null>{
  let link:string;
  const via=job.session||await sessionForJid(job.toId);
  try{ link=await groupInviteLink(job.toId,via); }
  catch(e:any){ return /not-authorized|forbidden/i.test(String(e?.message||e))?`Você precisa ser administrador do grupo "${job.toName}" para pegar o link de convite.`:e.message; }
  const text=template.replaceAll('{link}',link).replaceAll('{grupo}',job.toName);
  const phones=[...job.privacy];
  const inv:GroupInvite={total:phones.length,sent:0,failed:[],running:true,error:null};
  job.invite=inv; saveCopies();
  (async()=>{
    try{
      for(let i=0;i<phones.length;i++){
        try{ await sendWhatsAppWebText(`${phones[i]}@s.whatsapp.net`,text,undefined,via); inv.sent++; }
        catch(e:any){
          if(notConnected(e)) throw e;
          inv.failed.push(phones[i]);
        }
        if(i+1<phones.length) await new Promise(r=>setTimeout(r,25_000+Math.random()*20_000));
      }
    }catch(e:any){ inv.error=e?.message||String(e); }
    finally{ inv.running=false; saveCopies(); }
  })();
  return null;
}

// Liga o envio para os grupos escolhidos: cria o canal dos que ainda não são canal e reativa os pausados.
app.post('/api/whatsapp/channels', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({groups:z.array(z.object({id:z.string(),name:z.string()})).min(1)}).parse(req.body);
  const existing=await prisma.channel.findMany({where:{userId:req.user.id,type:'WHATSAPP_GROUP'},select:{id:true,destination:true,enabled:true}});
  const have=new Map(existing.map(c=>[c.destination,c]));
  let created=0; const resume:string[]=[];
  for(const g of body.groups){
    const c=have.get(g.id);
    if(!c){ await prisma.channel.create({data:{userId:req.user.id,type:'WHATSAPP_GROUP',name:g.name,destination:g.id}}); created++; }
    else if(!c.enabled) resume.push(c.id);
  }
  if(resume.length) await prisma.channel.updateMany({where:{id:{in:resume}},data:{enabled:true}});
  res.status(201).json({created,resumed:resume.length,skipped:body.groups.length-created-resume.length});
}));

// Para o envio nos grupos escolhidos (o canal fica pausado, não é excluído).
app.post('/api/whatsapp/channels/pause', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({groupIds:z.array(z.string()).min(1)}).parse(req.body);
  const r=await prisma.channel.updateMany({where:{userId:req.user.id,type:'WHATSAPP_GROUP',destination:{in:body.groupIds},enabled:true},data:{enabled:false}});
  res.json({paused:r.count});
}));

// Envio imediato de produtos para canais escolhidos (usado pela tela Capturar ofertas).
app.post('/api/offers/send-now', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({productIds:z.array(z.string()).min(1),channelIds:z.array(z.string()).min(1),template:z.string().optional(),fromTo:z.boolean().optional()}).parse(req.body);
  const products=await prisma.product.findMany({where:{id:{in:body.productIds},account:{userId:req.user.id}}});
  const channels=await prisma.channel.findMany({where:{id:{in:body.channelIds},userId:req.user.id,enabled:true}});
  if(!products.length) return res.status(400).json({error:'Nenhum produto válido.'});
  if(!channels.length) return res.status(400).json({error:'Nenhum canal ativo selecionado.'});
  // Todo job pertence a uma automação; envios manuais ficam agrupados em uma fixa por usuário.
  let manual=await prisma.automation.findFirst({where:{userId:req.user.id,name:'Envio manual'}});
  if(!manual) manual=await prisma.automation.create({data:{userId:req.user.id,name:'Envio manual',description:'Envios feitos pela tela Capturar ofertas',template:defaultOfferTemplate(),status:'ACTIVE'}});
  // Envio manual sempre usa o modelo padrão atual (o gravado em "Envio manual" é só registro).
  let template=body.template||defaultOfferTemplate();
  // Opção "De R$ tanto por R$ tanto": mostra ou esconde a linha do preço antigo.
  if(typeof body.fromTo==='boolean') template=toggleOldPrice(template,body.fromTo);
  let count=0;
  const coupons=await productCoupons(req.user.id);
  for(const p of products){
    const text=renderOffer(template,{title:p.title,price:p.price?Number(p.price):undefined,oldPrice:p.oldPrice?Number(p.oldPrice):undefined,discountPercent:p.discountPercent||undefined,couponText:p.couponText||pickCoupon(coupons,p),affiliateUrl:p.affiliateUrl});
    for(const c of channels){
      const job=await prisma.promotionJob.create({data:{automationId:manual.id,productId:p.id,channelId:c.id,scheduledAt:new Date(),payloadJson:{title:p.title,text,affiliateUrl:p.affiliateUrl,imageUrl:p.imageUrl}}});
      count++;
    }
  }
  res.status(201).json({count});
}));

// ---------- Clientes (atendimento no privado do WhatsApp) ----------
const botView=(b:any)=>({...b,marketplaces:Array.isArray(b.marketplaces)&&b.marketplaces.length?b.marketplaces:['SHOPEE','MERCADO_LIVRE']}); // Amazon só entra quando o usuário marca (a busca dela exige a Creators API)
async function customersPayload(userId:string){
  const bot=await getBot(userId);
  const customers=await prisma.customer.findMany({where:{userId},orderBy:{lastSeenAt:'desc'},take:500,include:{requests:{orderBy:{createdAt:'desc'},take:1,select:{keyword:true,status:true,createdAt:true,text:true}}}});
  const wa=getWaState();
  return {bot:botView(bot),link:customerLink(bot),waConnected:wa.status==='connected',waNumber:wa.me?.id||null,
    customers:customers.map(({requests,...c})=>({...c,lastRequest:requests[0]||null}))};
}
app.get('/api/customers', requireAuth, asyncRoute(async(req:any,res:any)=>res.json(await customersPayload(req.user.id))));
app.put('/api/customers/bot', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({enabled:z.boolean().optional(),everyMinutes:z.coerce.number().int().min(1).max(1440).optional(),maxOffers:z.coerce.number().int().min(1).max(10).optional(),marketplaces:z.array(z.enum(MARKETPLACE_LIST)).min(1).max(3).optional(),askMarketplace:z.boolean().optional(),sendCoupons:z.boolean().optional(),welcomeText:z.string().max(2000).optional().nullable(),linkText:z.string().max(120).optional().nullable()}).parse(req.body);
  await getBot(req.user.id);
  // A sessão do WhatsApp é uma só: ligar aqui desliga o atendimento de outro usuário que estivesse ligado.
  if(body.enabled) await prisma.customerBot.updateMany({where:{userId:{not:req.user.id},enabled:true},data:{enabled:false}});
  const data:any={...body}; if('welcomeText' in body) data.welcomeText=body.welcomeText?.trim()||null; if('linkText' in body) data.linkText=body.linkText?.trim()||null;
  await prisma.customerBot.update({where:{userId:req.user.id},data});
  res.json(await customersPayload(req.user.id));
}));
// QR code do link wa.me, para imprimir/postar.
app.get('/api/customers/link-qr', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const link=customerLink(await getBot(req.user.id)); if(!link) return res.status(409).json({error:'WhatsApp não conectado.'});
  res.json({link,qr:await QRCode.toDataURL(link,{margin:1,width:320})});
}));
// Testa como o robô entende uma frase (tela Clientes).
app.post('/api/customers/parse', requireAuth, (req:any,res:any)=>{ const body=z.object({text:z.string().min(1).max(500)}).parse(req.body); res.json(parseIntent(body.text)); });
app.get('/api/customers/:id/requests', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const c=await prisma.customer.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cliente não encontrado.'});
  res.json(await prisma.customerRequest.findMany({where:{customerId:c.id},orderBy:{createdAt:'desc'},take:100}));
}));
app.patch('/api/customers/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({blocked:z.boolean().optional(),optedOut:z.boolean().optional(),name:z.string().max(80).optional().nullable(),notes:z.string().max(1000).optional().nullable()}).parse(req.body);
  const c=await prisma.customer.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cliente não encontrado.'});
  res.json(await prisma.customer.update({where:{id:c.id},data:body}));
}));
app.delete('/api/customers/:id', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const c=await prisma.customer.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cliente não encontrado.'});
  await prisma.customer.delete({where:{id:c.id}}); res.json({ok:true});
}));
// Envio manual para UM cliente: busca por palavra-chave (sem limite por tempo) ou texto livre.
app.post('/api/customers/:id/send', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const body=z.object({keyword:z.string().trim().min(2).max(80).optional(),text:z.string().trim().min(1).max(2000).optional(),coupons:z.boolean().optional()}).parse(req.body);
  const c=await prisma.customer.findFirst({where:{id:req.params.id,userId:req.user.id}}); if(!c)return res.status(404).json({error:'Cliente não encontrado.'});
  if(c.optedOut) return res.status(409).json({error:'Este cliente pediu para não receber ofertas ("chega de oferta").'});
  if(!anyWaConnected()) return res.status(409).json({error:'WhatsApp não conectado. Escaneie o QR code em Canais.'});
  try{
    if(body.keyword){ const n=await sendOffersTo(await getBot(req.user.id),c,body.keyword,{wantsCoupons:body.coupons,manual:true}); return res.json({count:n}); }
    if(body.text){ await sendTextTo(c,body.text); return res.json({count:1}); }
    res.status(400).json({error:'Informe uma palavra-chave ou um texto.'});
  }catch(e:any){ res.status(400).json({error:e.message}); }
}));

// Usado pelo worker: a sessão do WhatsApp Web vive só neste processo.
app.post('/internal/whatsapp/send', asyncRoute(async(req:any,res:any)=>{
  if(!process.env.JWT_SECRET || req.headers['x-internal-secret']!==process.env.JWT_SECRET) return res.status(401).json({error:'Não autorizado.'});
  const body=z.object({jid:z.string(),text:z.string(),imageUrl:httpUrl().optional(),jobId:z.string().optional()}).parse(req.body);
  try{
    // Nova tentativa de um job já entregue (a resposta anterior ao worker se perdeu)? Não manda de novo.
    if(body.jobId){ const j=await prisma.promotionJob.findUnique({where:{id:body.jobId},select:{status:true}}); if(j?.status==='SENT') return res.json({ok:true,already:true}); }
    await sendWhatsAppWebText(body.jid,body.text,body.imageUrl);
    // Marca entregue aqui, no mesmo processo que entregou: se a resposta se perder, a retentativa vê SENT.
    if(body.jobId) await prisma.promotionJob.update({where:{id:body.jobId},data:{status:'SENT',sentAt:new Date(),errorMessage:null}}).catch(()=>{});
    res.json({ok:true});
  }catch(e:any){ res.status(409).json({error:e.message}); }
}));

app.get('/api/integrations/settings', requireAuth, asyncRoute(async(_req:any,res:any)=>{
  res.json({settings:await Promise.all(SETTING_KEYS.map(k=>describeSecret(k)))});
}));

app.put('/api/integrations/settings', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!['MASTER','ADMIN'].includes(req.user.role)) return res.status(403).json({error:'Somente administradores podem alterar credenciais.'});
  const shape=Object.fromEntries(SETTING_KEYS.map(k=>[k,z.string().optional()]));
  const body=z.object(shape).parse(req.body) as Record<string,string|undefined>;
  // Barreira contra autofill do navegador: e-mail/senha de login não são credenciais de plataforma.
  for(const [k,raw] of Object.entries(body)){
    const v=(raw??'').trim(); if(!v) continue;
    if(v.includes('@') && !['SMTP_USER','SMTP_FROM'].includes(k)) return res.status(400).json({error:`${k}: valor parece um e-mail. Informe a credencial da plataforma.`});
    if(k==='SHOPEE_APP_ID'&&!/^\d{6,}$/.test(v)) return res.status(400).json({error:'SHOPEE_APP_ID deve conter somente números (ex.: 18305511237).'});
    if(k==='SHOPEE_SECRET'&&v.length<16) return res.status(400).json({error:'SHOPEE_SECRET inválido: a chave da Open API é longa (32+ caracteres).'});
    if(k==='AMAZON_PARTNER_TAG'&&!/^[A-Za-z0-9._-]+-\d{2}$/.test(normalizeAmazonTag(v))) return res.status(400).json({error:'Tag da Amazon inválida: use a tag do Associates Central, que termina em -20 (ex.: seunome-20).'});
    if(k==='ML_CLIENT_ID'&&!/^\d+$/.test(v)) return res.status(400).json({error:'ML_CLIENT_ID deve conter somente números.'});
  }
  await saveSecrets(body as any, req.user.id);
  res.json({ok:true,settings:await Promise.all(SETTING_KEYS.map(k=>describeSecret(k)))});
}));

app.get('/api/integrations/status', requireAuth, asyncRoute(async(req:any,res:any)=>{
  const has=async(...k:string[])=>(await Promise.all(k.map(x=>getSecret(x as any)))).every(v=>!!v);
  const accounts=await prisma.affiliateAccount.findMany({where:{userId:req.user.id},select:{marketplace:true,accessToken:true,displayName:true}});
  const linked=(m:string)=>accounts.some(a=>a.marketplace===m && !!a.accessToken);
  res.json({
    mercadolivre:{configured:await has('ML_CLIENT_ID','ML_CLIENT_SECRET'),connected:linked('MERCADO_LIVRE'),vars:['ML_CLIENT_ID','ML_CLIENT_SECRET','ML_REDIRECT_URI']},
    // Shopee Affiliate não tem OAuth: com App ID + Secret salvos, a integração já está pronta.
    shopee:{configured:await has('SHOPEE_APP_ID','SHOPEE_SECRET'),connected:linked('SHOPEE')||await has('SHOPEE_APP_ID','SHOPEE_SECRET'),vars:['SHOPEE_APP_ID','SHOPEE_SECRET']},
    // Amazon: só a tag já gera links de afiliado; as credenciais da Creators API liberam a busca de produtos.
    amazon:{configured:await has('AMAZON_PARTNER_TAG'),connected:await has('AMAZON_PARTNER_TAG'),api:await has('AMAZON_CREDENTIAL_ID','AMAZON_CREDENTIAL_SECRET'),vars:['AMAZON_PARTNER_TAG','AMAZON_CREDENTIAL_ID','AMAZON_CREDENTIAL_SECRET']},
    whatsapp:{configured:await has('META_ACCESS_TOKEN','META_PHONE_NUMBER_ID'),connected:await has('META_ACCESS_TOKEN','META_PHONE_NUMBER_ID'),vars:['META_ACCESS_TOKEN','META_PHONE_NUMBER_ID','META_WABA_ID']},
    instagram:{configured:await has('META_ACCESS_TOKEN','META_IG_USER_ID'),connected:await has('META_ACCESS_TOKEN','META_IG_USER_ID'),vars:['META_ACCESS_TOKEN','META_IG_USER_ID']},
    email:{configured:await has('SMTP_HOST','SMTP_USER','SMTP_PASS'),connected:await has('SMTP_HOST','SMTP_USER','SMTP_PASS'),vars:['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM']}
  });
}));

app.get('/api/integrations/mercadolivre/connect', requireAuth, asyncRoute(async(req:any,res:any)=>{
  if(!(await getSecret('ML_CLIENT_ID')) || !(await getSecret('ML_CLIENT_SECRET'))) return res.status(400).json({error:'Preencha App ID e Secret do Mercado Livre e salve antes de conectar.'});
  const state=crypto.randomBytes(32).toString('hex'); const {verifier,challenge}=pkcePair();
  await prisma.oAuthState.create({data:{provider:'MERCADO_LIVRE',userId:req.user.id,stateHash:hash(state),codeVerifier:verifier,expiresAt:new Date(Date.now()+10*60*1000)}});
  res.json({authorizationUrl:await buildMercadoLivreAuthorizationUrl(state,challenge)});
}));

app.get('/api/integrations/mercadolivre/callback', asyncRoute(async(req:any,res:any)=>{
  const state=String(req.query.state||''); const code=String(req.query.code||''); if(!state||!code)return res.status(400).send('OAuth incompleto.');
  const oauth=await prisma.oAuthState.findFirst({where:{provider:'MERCADO_LIVRE',stateHash:hash(state),consumedAt:null,expiresAt:{gt:new Date()}}}); if(!oauth)return res.status(400).send('State inválido ou expirado.');
  const token=await exchangeMercadoLivreCode(code,oauth.codeVerifier||undefined);
  await prisma.affiliateAccount.upsert({where:{userId_marketplace:{userId:oauth.userId,marketplace:'MERCADO_LIVRE'}},create:{userId:oauth.userId,marketplace:'MERCADO_LIVRE',displayName:'Mercado Livre',accessToken:encryptSecret(token.access_token),refreshToken:encryptSecret(token.refresh_token),expiresAt:new Date(Date.now()+token.expires_in*1000),externalUserId:String(token.user_id)},update:{accessToken:encryptSecret(token.access_token),refreshToken:encryptSecret(token.refresh_token),expiresAt:new Date(Date.now()+token.expires_in*1000),externalUserId:String(token.user_id)}});
  await prisma.oAuthState.update({where:{id:oauth.id},data:{consumedAt:new Date()}});
  res.send('<h2>Mercado Livre conectado com sucesso.</h2><p>Você pode fechar esta janela e voltar ao Robô das Ofertas.</p>');
}));

app.post('/api/integrations/mercadolivre/refresh', requireAuth, asyncRoute(async(req:any,res:any)=>{
  // O refresh automático deve ser executado pelo worker; esta rota é apenas para diagnosticar/configurar a conta.
  const account=await prisma.affiliateAccount.findUnique({where:{userId_marketplace:{userId:req.user.id,marketplace:'MERCADO_LIVRE'}}}); if(!account?.refreshToken)return res.status(400).json({error:'Mercado Livre não conectado.'});
  res.json({connected:true,expiresAt:account.expiresAt});
}));

app.use((err:any,_req:any,res:any,_next:any)=>{ console.error(err); res.status(err?.name==='ZodError'?400:500).json({error:err?.message||'Erro interno.'}); });

const HOST=process.env.HOST||'127.0.0.1';
app.listen(Number(process.env.PORT||3333),HOST,()=>{ console.log('Robô das Ofertas API em http://localhost:3333'); warmUpCategories(); startCustomerBot(); connectSavedSessions(); startScheduler(); });

// HTTPS local (porta 3443): o Mercado Livre só aceita URL de retorno do OAuth em HTTPS.
// Certificado autoassinado gerado uma vez e guardado em apps/api/certs/ (fora do git).
try{
  const certDir=path.resolve(process.cwd(),'certs'); const keyFile=path.join(certDir,'localhost-key.pem'); const certFile=path.join(certDir,'localhost-cert.pem');
  if(!fs.existsSync(keyFile)||!fs.existsSync(certFile)){
    fs.mkdirSync(certDir,{recursive:true});
    // notBeforeDate um dia atrás: sem isso a biblioteca marca o início no futuro e o navegador recusa.
    const pems=selfsigned.generate([{name:'commonName',value:'localhost'}],{days:3650,keySize:2048,algorithm:'sha256',notBeforeDate:new Date(Date.now()-86_400_000),extensions:[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
    fs.writeFileSync(keyFile,pems.private); fs.writeFileSync(certFile,pems.cert);
  }
  const httpsPort=Number(process.env.HTTPS_PORT||3443);
  https.createServer({key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)},app).listen(httpsPort,HOST,()=>console.log(`Robô das Ofertas API (HTTPS p/ OAuth) em https://localhost:${httpsPort}`));
}catch(e:any){ console.error('HTTPS local não iniciado:',e.message); }
