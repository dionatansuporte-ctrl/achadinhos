import type { Marketplace } from '@prisma/client';
import { prisma } from '../db';

/**
 * Leitura de cupons a partir de texto (mensagem colada) e de canais públicos do Telegram.
 *
 * Canal público tem prévia web aberta em https://t.me/s/<canal>, sem login. Pegamos a
 * mensagem mais recente que contenha cupons e sincronizamos: os cupons importados do
 * Telegram passam a ser exatamente os dessa mensagem (o canal republica o que ainda vale);
 * cupons digitados pelo usuário não são tocados. O link do canal é de OUTRO afiliado e
 * é ignorado: no listão sai o link do usuário (CouponSchedule.link).
 *
 * Formatos reconhecidos (todos vistos em @melicupons e em listas coladas pelo usuário):
 *   🎟️ CODIGO - 10% OFF            |  🎟️ CODIGO              |  Código:
 *   acima de R$149 máximo R$200    |  R$250 OFF acima de R$2099 |  🎟️ CODIGO
 *                                                              |  10% OFF em compras acima de
 *                                                              |  R$149 e desconto limitado a R$200
 *   10% OFF acima de R$79, limite R$100: VALEMAIS
 *   20% OFF (Auto e ferramentas): USAESSAPROMO ou CUPOMOFF
 */

export type ParsedCoupon = { code: string; description: string; minPrice?: number };
export type ParsedList = { coupons: ParsedCoupon[]; link?: string };

const CODE = /^[A-Z][A-Z0-9]{3,}$|^[0-9][A-Z0-9]{3,}$/; // maiúsculas e dígitos, 4+ caracteres
const STOP = /https?:\/\/|cliquem|resgate|ajuda muito|ative aqui|#an[uú]ncio|^list[aã]o|^c[oó]digo:?$|^cupo(m|ns)\b/i;
const isCode = (t: string) => CODE.test(t) && !/^(OFF|MAX|MIN|TOP|TUDO)$/.test(t);

/** "R$1.599,90" / "1599" / "79" → número. */
function money(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Compra mínima a partir da descrição ("acima de R$149", "em 1599", "em compras acima de R$79"). */
export function minPriceFrom(desc: string): number | undefined {
  const m = /acima\s+de\s*R?\$?\s*([\d.]+(?:,\d{1,2})?)/i.exec(desc)
    || /\bem\s+(?:compras\s+)?(?:de\s+)?R?\$?\s*(\d{2,}(?:[.,]\d+)?)\b/i.exec(desc);
  return money(m?.[1]);
}

const clean = (t: string) => t.replace(/[🎟️🏷️✅👉👇•*_~`]/gu, '').replace(/\s+/g, ' ').trim();

/** Extrai os cupons de um texto livre. */
export function parseCouponText(text: string): ParsedList {
  const raw = text.replace(/\r/g, '').replace(/&#0?36;/g, '$').split('\n').map(l => l.trim());
  const link = /https?:\/\/\S+/.exec(text)?.[0];
  const out = new Map<string, ParsedCoupon>();
  const add = (code: string, desc: string) => {
    const description = clean(desc).replace(/^[-–:]\s*/, '').replace(/\s*[-–:,]\s*$/, '');
    if (!out.has(code)) out.set(code, { code, description, minPrice: minPriceFrom(description) });
  };

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line || STOP.test(clean(line))) continue;

    // Formato "descrição: CODIGO [ou CODIGO2 | CODIGO2 CODIGO3]"
    const colon = /^(.*\S)\s*:\s*([A-Z0-9][A-Z0-9 ]*[A-Z0-9])\s*$/.exec(line);
    if (colon) {
      const codes = colon[2].split(/\s+/).filter(t => t.toLowerCase() !== 'ou').filter(isCode);
      if (codes.length && codes.length === colon[2].split(/\s+/).filter(t => t.toLowerCase() !== 'ou').length) {
        for (const c of codes) add(c, colon[1]);
        continue;
      }
    }

    // Formato com 🎟️ (ou linha que é só o código): "🎟️ CODIGO - 10% OFF" + linhas seguintes até linha vazia
    const t = clean(line);
    const m = /^([A-Z0-9]+)(?:\s*[-–:]\s*(.*))?$/.exec(t);
    if (m && isCode(m[1])) {
      const parts: string[] = [m[2] || ''];
      let j = i + 1;
      while (j < raw.length && raw[j] && !STOP.test(clean(raw[j])) && !/^([A-Z0-9]+)(\s*[-–:].*)?$/.test(clean(raw[j]))) {
        parts.push(raw[j]); j++;
      }
      // Linha seguinte que é só outro código (sem descrição própria) não é descrição deste.
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

/** Mensagens da prévia pública de um canal (mais antigas primeiro). */
export async function fetchTelegramChannel(channel: string): Promise<TelegramPost[]> {
  const name = channel.replace(/^@/, '').replace(/^https?:\/\/(web\.)?t(elegram)?\.me\/(s\/|k\/#@?)?/i, '').replace(/^web\.telegram\.org\/k\/#@?/i, '').replace(/\/.*$/, '').trim();
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

/** Mensagem mais recente do canal que contém cupons. */
export async function latestTelegramCoupons(channel: string): Promise<{ post: TelegramPost; parsed: ParsedList } | null> {
  const posts = await fetchTelegramChannel(channel);
  for (const post of posts.reverse()) {
    const parsed = parseCouponText(post.text);
    if (parsed.coupons.length) return { post, parsed };
  }
  return null;
}

/**
 * Importa do canal para o usuário: cupons TELEGRAM deixam de existir fora da última mensagem,
 * novos entram, os que continuam só atualizam a descrição. Devolve o que mudou.
 */
export async function importTelegramCoupons(userId: string, marketplace: Marketplace, channel: string) {
  const found = await latestTelegramCoupons(channel);
  if (!found) throw new Error('Nenhuma mensagem com cupons encontrada no canal.');
  const { post, parsed } = found;
  const current = await prisma.coupon.findMany({ where: { userId, marketplace, source: 'TELEGRAM' } });
  const byCode = new Map(current.map(c => [c.code, c]));
  const keep = new Set<string>();
  let added = 0, updated = 0;
  for (const p of parsed.coupons) {
    keep.add(p.code);
    const c = byCode.get(p.code);
    if (c) {
      if (c.description !== p.description || Number(c.minPrice ?? 0) !== (p.minPrice ?? 0) || c.sourceRef !== post.ref) {
        await prisma.coupon.update({ where: { id: c.id }, data: { description: p.description, minPrice: p.minPrice ?? null, sourceRef: post.ref } });
        updated++;
      }
    } else {
      await prisma.coupon.create({ data: { userId, marketplace, code: p.code, description: p.description, minPrice: p.minPrice ?? null, source: 'TELEGRAM', sourceRef: post.ref } });
      added++;
    }
  }
  const gone = current.filter(c => !keep.has(c.code));
  if (gone.length) await prisma.coupon.deleteMany({ where: { id: { in: gone.map(c => c.id) } } });
  return { post: post.ref, at: post.at, total: parsed.coupons.length, added, updated, removed: gone.length };
}
