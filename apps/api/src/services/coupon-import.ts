import type { Marketplace } from '@prisma/client';
import { prisma } from '../db';

/**
 * Leitura de cupons a partir de texto (mensagem colada) e de canais públicos do Telegram.
 *
 * Canal público tem prévia web aberta em https://t.me/s/<canal>, sem login. Dois tipos de canal:
 *   - "listão" (@melicupons): uma mensagem com vários cupons, republicada com o que ainda vale.
 *     Só a lista mais recente conta;
 *   - "alerta" (@AlertaCupons): um post por cupom, misturando Shopee, Mercado Livre e outras
 *     lojas. Contam os posts do marketplace certo das últimas 24 h, e cada cupom recebe validade
 *     de 24 h a partir do post (cupom desses canais dura o dia).
 * Os cupons TELEGRAM do usuário passam a ser exatamente esse conjunto; cupons digitados pelo
 * usuário não são tocados. A agenda pode ter vários canais ("melicupons, AlertaCupons").
 * O link do canal é de OUTRO afiliado e é ignorado: no listão sai o link do usuário.
 *
 * Formatos reconhecidos (vistos em @melicupons, @AlertaCupons e em listas coladas pelo usuário):
 *   🎟️ CODIGO - 10% OFF            |  🎟️ CODIGO              |  Código:
 *   acima de R$149 máximo R$200    |  R$250 OFF acima de R$2099 |  🎟️ CODIGO
 *                                                              |  10% OFF em compras acima de
 *   🎟️ TODOSITE200 R$200 off R$1299   🎟️ FL15ES 15 OFF 69      |  R$149 e desconto limitado a R$200
 *   🎟️ CODIGO                (descrição no parágrafo seguinte)
 *   (linha em branco)
 *   R$40 OFF ACIMA DE R$199
 *   10% OFF acima de R$79, limite R$100: VALEMAIS
 *   20% OFF (Auto e ferramentas): USAESSAPROMO ou CUPOMOFF
 */

export type ParsedCoupon = { code: string; description: string; minPrice?: number };
export type ParsedList = { coupons: ParsedCoupon[]; link?: string };

/** Quanto tempo um post de canal "alerta" (um cupom por mensagem) continua valendo. */
export const ALERT_POST_TTL_MS = 24 * 60 * 60_000;
/** A partir de quantos cupons uma mensagem é um "listão" (só a mais recente conta, sem validade). */
const LIST_MIN_COUPONS = 3;

const CODE = /^[A-Z][A-Z0-9]{3,}$|^[0-9][A-Z0-9]{3,}$/; // maiúsculas e dígitos, 4+ caracteres
const STOP = /https?:\/\/|cliquem|resgate|ajuda muito|ative aqui|#an[uú]ncio|^list[aã]o|^c[oó]digo:?$|^cupo(m|ns)\b/i;
const isCode = (t: string) => CODE.test(t) && !/^(OFF|MAX|MIN|TOP|TUDO|SITE|LINK|FRETE|APP)$/.test(t);
// Descrição que vem na mesma linha do código separada só por espaço precisa parecer desconto
// ("R$200 off R$1299", "15 OFF 69", "10% OFF"), senão "COLE O LINK" viraria cupom COLE.
const DISCOUNT_START = /^(R?\$\s*\d|\d+\s*%|\d+\s*(off|reais)|-)/i;

/** "R$1.599,90" / "1599" / "79" → número. */
function money(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Compra mínima a partir da descrição ("acima de R$149", "em 1599", "R$200 off R$1299", "15 OFF 69"). */
export function minPriceFrom(desc: string): number | undefined {
  const m = /acima\s+de\s*R?\$?\s*([\d.]+(?:,\d{1,2})?)/i.exec(desc)
    || /\bem\s+(?:compras\s+)?(?:de\s+)?R?\$?\s*(\d{2,}(?:[.,]\d+)?)\b/i.exec(desc)
    || /\boff\s+R?\$?\s*(\d{2,}(?:[.,]\d+)?)\s*$/i.exec(desc);
  return money(m?.[1]);
}

/** "15 OFF 69" / "R$200 off R$1299" → "R$15 OFF acima de R$69" (padrão das listas). */
function normalizeDescription(desc: string) {
  const m = /^R?\$?\s*(\d+(?:[.,]\d+)?)\s*off\s+R?\$?\s*(\d+(?:[.,]\d+)?)$/i.exec(desc);
  return m ? `R$${m[1]} OFF acima de R$${m[2]}` : desc;
}

// Tira emoji, seletores de variação, tons de pele e marcadores de lista do começo/meio da linha.
const clean = (t: string) => t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}•*_~`]/gu, '').replace(/\s+/g, ' ').trim();

/** Extrai os cupons de um texto livre. */
export function parseCouponText(text: string): ParsedList {
  const raw = text.replace(/\r/g, '').replace(/&#0?36;/g, '$').split('\n').map(l => l.trim());
  const link = /https?:\/\/\S+/.exec(text)?.[0];
  const out = new Map<string, ParsedCoupon>();
  const add = (code: string, desc: string) => {
    const description = normalizeDescription(clean(desc).replace(/^[-–:]\s*/, '').replace(/\s*[-–:,]\s*$/, '')).replace(/\bACIMA\s+DE\b/g, 'acima de');
    if (!out.has(code)) out.set(code, { code, description, minPrice: minPriceFrom(description) });
  };
  const codeLine = (t: string) => /^([A-Z0-9]+)(?:\s*[-–:]\s*(.*)|\s+(.*))?$/.exec(t);

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line || STOP.test(clean(line))) continue;

    // Formato "descrição: CODIGO [ou CODIGO2 | CODIGO2 CODIGO3]"
    const colon = /^(.*\S)\s*:\s*([A-Z0-9]+(?:\s+(?:ou\s+)?[A-Z0-9]+)*)\s*$/.exec(line);
    if (colon) {
      const codes = colon[2].split(/\s+/).filter(t => t.toLowerCase() !== 'ou').filter(isCode);
      if (codes.length && codes.length === colon[2].split(/\s+/).filter(t => t.toLowerCase() !== 'ou').length) {
        for (const c of codes) add(c, colon[1]);
        continue;
      }
    }

    // Formato com 🎟️ (ou linha que é só o código): "🎟️ CODIGO - 10% OFF", "🎟️ CODIGO R$20 off R$199",
    // ou "🎟️ CODIGO" com a descrição nas linhas seguintes (mesmo depois de uma linha em branco).
    const t = clean(line);
    const m = codeLine(t);
    if (m && isCode(m[1])) {
      const inline = m[2] ?? (m[3] && DISCOUNT_START.test(m[3]) ? m[3] : undefined);
      if (m[3] !== undefined && inline === undefined) continue; // "COLE O LINK...": não é cupom
      const parts: string[] = [inline || ''];
      let j = i + 1;
      // Sem descrição na linha: pula linhas em branco até o próximo parágrafo.
      if (!inline) while (j < raw.length && !raw[j]) j++;
      while (j < raw.length && raw[j] && !STOP.test(clean(raw[j])) && !(codeLine(clean(raw[j]))?.[1] && isCode(codeLine(clean(raw[j]))![1]))) {
        parts.push(raw[j]); j++;
      }
      add(m[1], parts.filter(Boolean).join(' '));
      i = j - 1;
    }
  }
  return { coupons: [...out.values()], link };
}

const decodeHtml = (s: string) => s
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#0?36;/g, '$').replace(/&#33;/g, '!').replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

export type TelegramPost = { ref: string; text: string; at?: string };

/** "@canal", "canal", t.me/canal, t.me/s/canal, web.telegram.org/k/#@canal (com ou sem https://) → "canal". */
export function telegramChannelName(channel: string) {
  return channel.trim().replace(/^https?:\/\//i, '').replace(/^(web\.)?t(elegram)?\.me\/(s\/)?/i, '').replace(/^web\.telegram\.org\/[a-z]\/#/i, '').replace(/^@/, '').replace(/[/?#].*$/, '').trim();
}

/** Vários canais numa agenda: "melicupons, AlertaCupons" ou um por linha. */
export function telegramChannelList(channels: string) {
  return [...new Set(channels.split(/[,;\n\s]+/).map(telegramChannelName).filter(Boolean))];
}

/** Mensagens da prévia pública de um canal (mais antigas primeiro). */
export async function fetchTelegramChannel(channel: string): Promise<TelegramPost[]> {
  const name = telegramChannelName(channel);
  if (!/^[A-Za-z0-9_]{4,}$/.test(name)) throw new Error('Canal do Telegram inválido. Use o nome público, ex.: melicupons.');
  const r = await fetch(`https://t.me/s/${name}`, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Telegram respondeu ${r.status} para o canal ${name}.`);
  const html = await r.text();
  const posts: TelegramPost[] = [];
  const re = /data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>(?:[\s\S]*?<time datetime="([^"]+)")?/g;
  for (const m of html.matchAll(re)) posts.push({ ref: m[1], text: decodeHtml(m[2]), at: m[3] });
  if (!posts.length) throw new Error(`Não achei mensagens públicas em t.me/s/${name}. O canal é público?`);
  return posts;
}

/**
 * De qual loja é o post. Canal misto (@AlertaCupons) fala "SHOPEE"/"MERCADO LIVRE" ou traz o
 * link da loja; post de outra loja (Magalu, Amazon...) é OTHER; sem pista nenhuma é null
 * (canal dedicado como @melicupons, que não repete o nome da loja).
 */
export function postMarketplace(text: string): Marketplace | 'OTHER' | null {
  if (/shopee|shope\b|s\.shopee\.com/i.test(text)) return 'SHOPEE';
  if (/mercado\s*livre|mercadolivre|mercadolibre|\bmeli\b|\bml\b/i.test(text)) return 'MERCADO_LIVRE';
  if (/magalu|magazine\s*luiza|magazinevoce|amazon|amzn|americanas|aliexpress|casas\s*bahia|kabum|netshoes|centauro|natura|boticario|ifood|temu|shein/i.test(text)) return 'OTHER';
  return null;
}

/** Mensagem mais recente do canal que contém cupons (qualquer loja). */
export async function latestTelegramCoupons(channel: string): Promise<{ post: TelegramPost; parsed: ParsedList } | null> {
  const posts = await fetchTelegramChannel(channel);
  for (const post of posts.reverse()) {
    const parsed = parseCouponText(post.text);
    if (parsed.coupons.length) return { post, parsed };
  }
  return null;
}

export type ChannelCoupon = ParsedCoupon & { ref: string; validUntil: Date | null };

/**
 * Cupons ativos de um marketplace num canal, agora:
 *   - o listão (mensagem com 3+ cupons) mais recente da loja, sem validade;
 *   - mais os posts de alerta (1-2 cupons) da loja das últimas 24 h, valendo 24 h a partir do post.
 * Post que não diz a loja conta como sendo do marketplace pedido; post de outra loja fica de fora.
 */
export async function activeChannelCoupons(channel: string, marketplace: Marketplace, now = new Date()): Promise<ChannelCoupon[]> {
  const posts = await fetchTelegramChannel(channel);
  const name = telegramChannelName(channel);
  const out: ChannelCoupon[] = [];
  let latestList: { at: number; coupons: ChannelCoupon[] } | null = null;
  for (const post of posts) {
    const mkt = postMarketplace(post.text);
    if (mkt && mkt !== marketplace) continue;
    const parsed = parseCouponText(post.text);
    if (!parsed.coupons.length) continue;
    const at = post.at ? new Date(post.at).getTime() : NaN;
    const ref = post.ref.includes('/') ? post.ref : `${name}/${post.ref}`;
    if (parsed.coupons.length >= LIST_MIN_COUPONS) {
      const list = parsed.coupons.map(c => ({ ...c, ref, validUntil: null }));
      if (!latestList || !(at < latestList.at)) latestList = { at, coupons: list };
      continue;
    }
    const validUntil = Number.isFinite(at) ? new Date(at + ALERT_POST_TTL_MS) : null;
    if (validUntil && validUntil.getTime() < now.getTime()) continue;
    for (const c of parsed.coupons) out.push({ ...c, ref, validUntil });
  }
  return [...(latestList?.coupons || []), ...out];
}

/**
 * Importa do(s) canal(is) para o usuário: cupons TELEGRAM do marketplace passam a ser exatamente
 * os ativos nos canais; novos entram, os que continuam só atualizam descrição/validade, os que
 * sumiram são apagados. Devolve o que mudou. Com vários canais, um canal fora do ar não derruba
 * os outros (só falha se nenhum respondeu).
 */
export async function importTelegramCoupons(userId: string, marketplace: Marketplace, channels: string) {
  const names = telegramChannelList(channels);
  if (!names.length) throw new Error('Informe o canal público do Telegram (ex.: melicupons).');
  const found: ChannelCoupon[] = [];
  const errors: string[] = [];
  for (const name of names) {
    try { found.push(...await activeChannelCoupons(name, marketplace)); }
    catch (e: any) { errors.push(`${name}: ${e.message}`); }
  }
  if (errors.length === names.length) throw new Error(errors.join(' | '));

  // Mesmo código em dois posts: fica o que vale por mais tempo (null = sem validade).
  const byCodeNew = new Map<string, ChannelCoupon>();
  for (const c of found) {
    const prev = byCodeNew.get(c.code);
    if (!prev || prev.validUntil && (!c.validUntil || c.validUntil > prev.validUntil)) byCodeNew.set(c.code, c);
  }
  const current = await prisma.coupon.findMany({ where: { userId, marketplace, source: 'TELEGRAM' } });
  const byCode = new Map(current.map(c => [c.code, c]));
  let added = 0, updated = 0;
  for (const p of byCodeNew.values()) {
    const c = byCode.get(p.code);
    if (c) {
      const same = c.description === p.description && Number(c.minPrice ?? 0) === (p.minPrice ?? 0) && c.sourceRef === p.ref
        && (c.validUntil?.getTime() ?? null) === (p.validUntil?.getTime() ?? null);
      if (!same) {
        await prisma.coupon.update({ where: { id: c.id }, data: { description: p.description, minPrice: p.minPrice ?? null, sourceRef: p.ref, validUntil: p.validUntil } });
        updated++;
      }
    } else {
      await prisma.coupon.create({ data: { userId, marketplace, code: p.code, description: p.description, minPrice: p.minPrice ?? null, source: 'TELEGRAM', sourceRef: p.ref, validUntil: p.validUntil } });
      added++;
    }
  }
  const gone = current.filter(c => !byCodeNew.has(c.code));
  if (gone.length) await prisma.coupon.deleteMany({ where: { id: { in: gone.map(c => c.id) } } });
  const refs = [...new Set([...byCodeNew.values()].map(c => c.ref))];
  return { post: refs.join(', '), at: undefined as string | undefined, total: byCodeNew.size, added, updated, removed: gone.length, errors };
}
