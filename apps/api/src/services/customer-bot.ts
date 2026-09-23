import type { Customer, CustomerBot, Marketplace } from '@prisma/client';
import { prisma } from '../db';
import { onWhatsAppMessage, sendWhatsAppWebText, showTyping, getWaState, type WaIncoming } from '../integrations/whatsapp-web';
import type { ShopeeOffer } from '../integrations/shopee';
import { searchOffers, type SearchMarketplace } from './shopee-sync';
import { renderOffer, defaultOfferTemplate } from './offer';
import { titleKey } from './title-key';
import { productCoupons, pickCoupon, usableCoupons, couponListMessage, marketplaceName, MARKETPLACES } from './coupons';

/**
 * Atendimento a clientes no privado do WhatsApp.
 *
 * O cliente entra pelo link wa.me do número pareado e escreve o que procura
 * ("quero oferta de fone bluetooth"). O robô busca na Shopee/Mercado Livre e responde
 * só para ele, com o link de afiliado. Regras pedidas pelo usuário:
 *   - limite por tempo: cada cliente é atendido no máximo uma vez a cada `everyMinutes`
 *     (evita enxurrada de mensagens e o WhatsApp marcar o número como spam);
 *   - pediu cupom? manda também o listão de cupons válidos;
 *   - "chega de oferta" desliga o cliente (optedOut) e "quero oferta" liga de novo.
 * Tudo que chega vira uma linha em CustomerRequest, que a tela Clientes mostra.
 */

const DEFAULT_WELCOME = [
  'Olá! 👋 Sou o robô de ofertas.',
  '',
  'Me diga o que você procura e eu te mando as melhores ofertas. Exemplos:',
  '• _fone bluetooth_',
  '• _air fryer_',
  '• _tênis masculino_',
  '',
  'Quer cupons? Escreva *cupom*.',
  'Para não receber mais nada, escreva *chega de oferta*.'
].join('\n');

// "para" (preposição) fica de fora de propósito: "oferta para cozinha" não é pedido de saída.
const OPT_OUT_RE = /\b(chega|parar|pare|cancelar?|sair|remover?|descadastrar|n[aã]o quero mais|stop)\b/i;
const OPT_IN_RE = /^\s*(quero\s+ofertas?|come[cç]ar|iniciar|voltar|ativar|start)\s*!*\.?\s*$/i;
const GREETING_RE = /^\s*(oi+|ol[aá]|opa|e a[ií]|bom dia|boa tarde|boa noite|hey|hello|ajuda|help|menu|\?+)[\s!.,]*$/i;
const COUPON_RE = /\bcupo(m|ns)\b|\bdesconto\b/i;
// Palavras que só enfeitam o pedido: "quero uma oferta de fone bluetooth" -> "fone bluetooth".
const FILLER_RE = /\b(quero|queria|gostaria|preciso|procuro|procurando|estou|to|tô|tem|teria|ter|me|manda|mande|mandar|envia|envie|enviar|traz|traga|trazer|ver|uma?|umas?|uns|o|a|os|as|de|do|da|dos|das|em|no|na|pra|para|por|favor|pfv|pf|oferta|ofertas|promo[cç][aã]o|promo[cç][oõ]es|promo|barato|barata|bom|boa|melhor|melhores|pre[cç]o|cupom|cupons|desconto|com|e|ou|algum|alguma|alguns|algumas|que|qual|quais|voc[eê]|vc|tu|ai|a[ií]|kkk+|rs)\b/gi;

export type Intent =
  | { kind: 'OPT_OUT' }
  | { kind: 'OPT_IN' }
  | { kind: 'HELP' }
  | { kind: 'SEARCH'; keyword: string; wantsCoupons: boolean }
  | { kind: 'COUPONS' };

/** Interpreta o texto do cliente. */
export function parseIntent(raw: string): Intent {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (OPT_IN_RE.test(text)) return { kind: 'OPT_IN' };
  if (OPT_OUT_RE.test(text) && text.length <= 40) return { kind: 'OPT_OUT' };
  if (GREETING_RE.test(text) || text.length < 3) return { kind: 'HELP' };
  const wantsCoupons = COUPON_RE.test(text);
  const keyword = text.replace(/https?:\/\/\S+/gi, ' ').replace(FILLER_RE, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!keyword || keyword.length < 2) return wantsCoupons ? { kind: 'COUPONS' } : { kind: 'HELP' };
  return { kind: 'SEARCH', keyword, wantsCoupons };
}

/** Configuração do atendimento do usuário; cria com os padrões na primeira vez. */
export async function getBot(userId: string) {
  return prisma.customerBot.upsert({ where: { userId }, update: {}, create: { userId } });
}

export function botMarketplaces(bot: CustomerBot): SearchMarketplace[] {
  const list = (Array.isArray(bot.marketplaces) ? bot.marketplaces : []).filter((m): m is SearchMarketplace => m === 'SHOPEE' || m === 'MERCADO_LIVRE');
  return list.length ? list : ['SHOPEE', 'MERCADO_LIVRE'];
}

/** Link que o usuário divulga: abre o WhatsApp do número pareado com o texto já digitado. */
export function customerLink(bot: CustomerBot) {
  const me = getWaState().me?.id;
  if (!me) return null;
  const text = (bot.linkText || 'Quero oferta').trim();
  return `https://wa.me/${me.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

const minutesLeft = (since: Date, everyMinutes: number) => Math.max(1, Math.ceil((since.getTime() + everyMinutes * 60_000 - Date.now()) / 60_000));

async function log(customerId: string, data: { text: string; keyword?: string | null; status: string; replyText?: string | null; offersJson?: any; error?: string | null }) {
  return prisma.customerRequest.create({ data: { customerId, ...data, offersJson: data.offersJson ?? undefined } });
}

async function reply(jid: string, text: string, imageUrl?: string) {
  await showTyping(jid, Math.min(4000, 800 + text.length * 8));
  await sendWhatsAppWebText(jid, text, imageUrl);
}

/** Texto de uma oferta para o cliente, com o cupom do marketplace se houver um válido que caiba. */
function offerText(o: ShopeeOffer, coupons: Awaited<ReturnType<typeof productCoupons>>) {
  const marketplace = (o.marketplace || 'SHOPEE') as Marketplace;
  return renderOffer(defaultOfferTemplate(), {
    title: o.title, price: o.price, oldPrice: o.oldPrice, discountPercent: o.discountPercent,
    couponText: pickCoupon(coupons, { marketplace, price: o.price ?? null }), affiliateUrl: o.affiliateUrl
  });
}

/** Listões de cupom (um por marketplace com cupom válido). Vazio = não há cupom nenhum. */
async function couponMessages(userId: string, marketplaces: SearchMarketplace[]) {
  const out: string[] = [];
  for (const m of MARKETPLACES.filter(m => marketplaces.includes(m))) {
    const list = await usableCoupons(userId, m);
    if (list.length) out.push(couponListMessage(m, list, null));
  }
  return out;
}

/**
 * Busca e envia as ofertas de `keyword` para o cliente. Usado pela resposta automática e pelo
 * botão "Enviar oferta" da tela (aí sem limite por tempo). Devolve quantas ofertas saíram.
 */
export async function sendOffersTo(bot: CustomerBot, customer: Customer, keyword: string, opts: { wantsCoupons?: boolean; text?: string; manual?: boolean } = {}) {
  const marketplaces = botMarketplaces(bot);
  const limit = Math.min(10, Math.max(1, bot.maxOffers || 3));
  let offers: ShopeeOffer[] = [];
  try {
    // Melhor oferta = mais vendidos (pedido do usuário). Busca o dobro e descarta anúncios com o
    // mesmo título, para o cliente receber produtos DIFERENTES e não 3 vezes o mesmo fone.
    const found = await searchOffers(customer.userId, { marketplaces, keywords: [keyword], sorts: ['SALES'], limit: limit * 2 });
    const seen = new Set<string>();
    offers = found.filter(o => { const k = titleKey(o.title) || o.itemId; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
  } catch (e: any) {
    await log(customer.id, { text: opts.text || keyword, keyword, status: 'FAILED', error: e.message });
    if (!opts.manual) await reply(customer.jid, `Ops, não consegui buscar "${keyword}" agora. Tente de novo em alguns minutos. 🙏`).catch(() => {});
    throw e;
  }
  const coupons = bot.sendCoupons ? await productCoupons(customer.userId) : [];
  const couponTexts = opts.wantsCoupons && bot.sendCoupons ? await couponMessages(customer.userId, marketplaces) : [];

  if (!offers.length) {
    const text = couponTexts.length
      ? `Não achei ofertas de *${keyword}* agora 😕 Mas aqui vão os cupons de hoje:`
      : `Não achei ofertas de *${keyword}* agora 😕\n\nTente com outro nome (ex.: _fone bluetooth_, _air fryer_).`;
    await reply(customer.jid, text);
    for (const c of couponTexts) await reply(customer.jid, c);
    await log(customer.id, { text: opts.text || keyword, keyword, status: opts.manual ? 'MANUAL' : 'EMPTY', replyText: text, offersJson: [] });
    return 0;
  }

  const intro = offers.length === 1 ? `Achei esta oferta de *${keyword}* pra você 👇` : `Achei ${offers.length} ofertas de *${keyword}* pra você 👇`;
  await reply(customer.jid, intro);
  const sent: any[] = [];
  for (const o of offers) {
    const text = offerText(o, coupons);
    await reply(customer.jid, text, o.imageUrl);
    sent.push({ itemId: o.itemId, title: o.title, price: o.price, oldPrice: o.oldPrice, imageUrl: o.imageUrl, affiliateUrl: o.affiliateUrl, marketplace: o.marketplace || marketplaces[0] });
  }
  for (const c of couponTexts) await reply(customer.jid, c);
  if (opts.wantsCoupons && bot.sendCoupons && !couponTexts.length) await reply(customer.jid, 'No momento não tenho cupom válido, mas as ofertas acima já estão com o melhor preço que encontrei. 😉');

  await prisma.customer.update({ where: { id: customer.id }, data: { requestCount: { increment: 1 }, lastRequestAt: opts.manual ? undefined : new Date() } });
  await log(customer.id, { text: opts.text || keyword, keyword, status: opts.manual ? 'MANUAL' : 'ANSWERED', replyText: intro, offersJson: sent });
  return offers.length;
}

/** Manda um texto livre para o cliente (botão da tela). */
export async function sendTextTo(customer: Customer, text: string) {
  await reply(customer.jid, text);
  await log(customer.id, { text: '(painel)', status: 'MANUAL', replyText: text });
}

/** Qual usuário atende o privado: o único que tem o atendimento ligado (a sessão do WhatsApp é uma só). */
async function activeBot() {
  return prisma.customerBot.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
}

async function handleIncoming(m: WaIncoming) {
  const bot = await activeBot();
  if (!bot) return;
  const customer = await prisma.customer.upsert({
    where: { userId_jid: { userId: bot.userId, jid: m.jid } },
    create: { userId: bot.userId, jid: m.jid, phone: m.phone, name: m.name },
    update: { lastSeenAt: new Date(), ...(m.name ? { name: m.name } : {}), ...(m.phone ? { phone: m.phone } : {}) }
  });
  if (customer.blocked) { await log(customer.id, { text: m.text, status: 'BLOCKED' }); return; }

  const intent = parseIntent(m.text);

  if (intent.kind === 'OPT_OUT') {
    await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: true } });
    const text = 'Combinado! Não vou mais te mandar ofertas. 🙂\n\nSe mudar de ideia, é só escrever *quero oferta*.';
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'OPT_OUT', replyText: text });
    return;
  }
  if (intent.kind === 'OPT_IN') {
    await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: false } });
    const text = bot.welcomeText?.trim() || DEFAULT_WELCOME;
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'OPT_IN', replyText: text });
    return;
  }
  // Cliente que pediu "chega": silêncio total até ele mandar "quero oferta".
  if (customer.optedOut) { await log(customer.id, { text: m.text, status: 'OPT_OUT' }); return; }

  if (intent.kind === 'HELP') {
    // Saudação repetida dentro do intervalo não ganha outro menu (evita ping-pong com outro robô).
    if (customer.lastNoticeAt && Date.now() - customer.lastNoticeAt.getTime() < 10 * 60_000) { await log(customer.id, { text: m.text, status: 'HELP' }); return; }
    const text = bot.welcomeText?.trim() || DEFAULT_WELCOME;
    await reply(m.jid, text);
    await prisma.customer.update({ where: { id: customer.id }, data: { lastNoticeAt: new Date() } });
    await log(customer.id, { text: m.text, status: 'HELP', replyText: text });
    return;
  }

  // Limite por tempo: um atendimento por cliente a cada everyMinutes.
  if (customer.lastRequestAt && Date.now() - customer.lastRequestAt.getTime() < bot.everyMinutes * 60_000) {
    const left = minutesLeft(customer.lastRequestAt, bot.everyMinutes);
    const keyword = intent.kind === 'SEARCH' ? intent.keyword : null;
    // Avisa uma vez por janela; as demais mensagens ficam só registradas.
    if (!customer.lastNoticeAt || customer.lastNoticeAt < customer.lastRequestAt) {
      const text = `Acabei de te mandar ofertas há pouco. 😉 Posso buscar de novo em *${left} min*${keyword ? ` — aí te mando *${keyword}*` : ''}.`;
      await reply(m.jid, text);
      await prisma.customer.update({ where: { id: customer.id }, data: { lastNoticeAt: new Date() } });
      await log(customer.id, { text: m.text, keyword, status: 'LIMITED', replyText: text });
    } else await log(customer.id, { text: m.text, keyword, status: 'LIMITED' });
    return;
  }

  if (intent.kind === 'COUPONS') {
    const texts = bot.sendCoupons ? await couponMessages(bot.userId, botMarketplaces(bot)) : [];
    const text = texts.length ? texts.join('\n\n') : 'No momento não tenho cupom válido. 😕 Me diga um produto e eu busco a melhor oferta pra você!';
    for (const t of texts.length ? texts : [text]) await reply(m.jid, t);
    await prisma.customer.update({ where: { id: customer.id }, data: { requestCount: { increment: 1 }, lastRequestAt: new Date() } });
    await log(customer.id, { text: m.text, status: 'ANSWERED', replyText: text });
    return;
  }

  await sendOffersTo(bot, customer, intent.keyword, { wantsCoupons: intent.wantsCoupons, text: m.text }).catch(() => {});
}

// Fila por cliente: duas mensagens seguidas do mesmo número são tratadas uma depois da outra.
const chains = new Map<string, Promise<void>>();
export function startCustomerBot() {
  onWhatsAppMessage(m => {
    const prev = chains.get(m.jid) || Promise.resolve();
    const next = prev.then(() => handleIncoming(m)).catch(e => console.error('[clientes]', e?.message || e)).finally(() => { if (chains.get(m.jid) === next) chains.delete(m.jid); });
    chains.set(m.jid, next);
    return next;
  });
}
