export type Marketplace = 'SHOPEE' | 'MERCADO_LIVRE' | 'OUTRO';

export type ParsedOffer = {
  id: string;
  title: string;
  price?: number;
  oldPrice?: number;
  discountPercent?: number;
  coupon?: string;
  productUrl: string;
  marketplace: Marketplace;
};

const RE_URL = /https?:\/\/[^\s<>"']+/gi;
// Preço explícito: com "R$" ou com centavos ("R$ 89,90", "89,90").
const RE_MONEY = /R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\b\d{1,3}(?:\.\d{3})*,\d{1,2}\b/gi;
// Número solto, só quando não houver preço explícito. O lookbehind evita ler
// o "20" de "Smartwatch D20" como valor.
const RE_LOOSE_MONEY = /(?<![A-Za-z\d.,])\d{1,3}(?:\.\d{3})*(?![A-Za-z])/g;
const RE_DE_POR = /\bde\s*R?\$?\s*([\d.,]+)\s*(?:por|para|→|->)\s*R?\$?\s*([\d.,]+)/i;
const RE_CUPOM = /\b(?:cupom|cupon|c[óo]digo|coupon|use)\s*(?:de\s*desconto\s*)?[:\-–]?\s*([A-Z0-9][A-Z0-9._-]{2,24})\b/i;
const RE_PERCENT = /(\d{1,3})\s*%\s*(?:off|de\s*desconto)?/i;

/** "1.234,56" e "1234.56" viram 1234.56. */
export function parseMoney(raw: string): number | undefined {
  const t = raw.replace(/[^\d.,]/g, '');
  if (!t) return undefined;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : undefined;
}

function marketplaceOf(url: string): Marketplace {
  if (/shopee\.|shope\.ee/i.test(url)) return 'SHOPEE';
  if (/mercadoliv|mercadolibre|mlb|\bmeli\b/i.test(url)) return 'MERCADO_LIVRE';
  return 'OUTRO';
}

/**
 * Mensagens de grupo trazem várias ofertas seguidas. Cada link encerra um bloco,
 * então o texto é fatiado por link e o que vem antes descreve aquela oferta.
 */
function splitBlocks(text: string): { body: string; url: string }[] {
  const blocks: { body: string; url: string }[] = [];
  let cursor = 0;
  for (const m of text.matchAll(RE_URL)) {
    const url = m[0].replace(/[).,;]+$/, '');
    const body = text.slice(cursor, m.index ?? cursor);
    blocks.push({ body, url });
    cursor = (m.index ?? cursor) + m[0].length;
  }
  return blocks;
}

// Cabeçalhos e chamadas do grupo, que aparecem coladas ao produto.
const RE_RUIDO = /^(promo(ç|c)[ãa]o|oferta|achadinho|corre|aproveite|imperd[ií]vel|rel[âa]mpago|link|compre|frete\s*gr[áa]tis|[úu]ltimas?\s+unidades?|acabou|bora)\b/i;

/** Linha mais provável de ser o nome do produto dentro do bloco. */
function pickTitle(body: string): string {
  const lines = body
    .split(/\n+/)
    .map(l => l.replace(/[*_~`]/g, '').trim())
    // Emoji e pontuação de enfeite no começo da linha.
    .map(l => l.replace(/^[^\p{L}\p{N}]+/u, '').trim())
    .filter(Boolean)
    // Descarta linhas que são só preço, cupom, chamada ou enfeite.
    .filter(l => !/^(de|por|apenas|agora|s[óo])\b/i.test(l))
    .filter(l => !RE_CUPOM.test(l))
    .filter(l => !RE_RUIDO.test(l))
    .filter(l => !/^[\W\d\s]+$/.test(l))
    .filter(l => l.replace(/[^\p{L}]/gu, '').length >= 4);
  if (!lines.length) return '';
  // A oferta fica logo acima do link, então a última linha vale mais que a primeira.
  const long = [...lines].reverse().find(l => l.length >= 12);
  const title = long || lines.sort((a, b) => b.length - a.length)[0] || '';
  // "Smartwatch D20 - R$ 39,90" → o preço colado no fim não faz parte do nome.
  return title
    .replace(/\s*[-–—|:]?\s*(por\s*)?R\$\s*\d[\d.,]*\s*$/i, '')
    .trim()
    .slice(0, 180);
}

export function parseOffers(text: string): ParsedOffer[] {
  const clean = (text || '').replace(/\r/g, '');
  if (!clean.trim()) return [];

  const out: ParsedOffer[] = [];
  const seen = new Set<string>();

  splitBlocks(clean).forEach((block, i) => {
    const { body, url } = block;
    if (seen.has(url)) return;
    seen.add(url);

    const offer: ParsedOffer = {
      id: `${i}-${url}`,
      title: pickTitle(body) || 'Produto sem nome',
      productUrl: url,
      marketplace: marketplaceOf(url)
    };

    const dePor = body.match(RE_DE_POR);
    if (dePor) {
      offer.oldPrice = parseMoney(dePor[1] ?? '');
      offer.price = parseMoney(dePor[2] ?? '');
    } else {
      // Sem "de/por": o menor valor citado é o preço atual, o maior vira o preço antigo.
      // Percentuais ("42% OFF") são removidos antes para não virarem preço.
      const noPercent = body.replace(/\d{1,3}\s*%/g, ' ');
      const explicit = [...noPercent.matchAll(RE_MONEY)].map(m => m[0]);
      const raws = explicit.length ? explicit : [...noPercent.matchAll(RE_LOOSE_MONEY)].map(m => m[0]);
      const values = raws
        .map(r => parseMoney(r))
        .filter((n): n is number => typeof n === 'number' && n > 0)
        // Anos não são preço.
        .filter(n => !(Number.isInteger(n) && n >= 1900 && n <= 2100));
      if (values.length) {
        offer.price = Math.min(...values);
        const max = Math.max(...values);
        if (max > offer.price) offer.oldPrice = max;
      }
    }

    const cupom = body.match(RE_CUPOM);
    if (cupom?.[1]) offer.coupon = cupom[1].toUpperCase();

    if (offer.price && offer.oldPrice && offer.oldPrice > offer.price) {
      offer.discountPercent = Math.round((1 - offer.price / offer.oldPrice) * 100);
    } else {
      const pct = body.match(RE_PERCENT);
      if (pct?.[1]) offer.discountPercent = Number(pct[1]);
    }

    out.push(offer);
  });

  return out;
}

/**
 * Aplica a regra de afiliação do usuário à URL original.
 * `suffix` é a query de tracking do programa dele (ex.: "af_siteid=123&utm_source=x").
 * Sem regra configurada, devolve a URL como veio — nunca inventa um link de afiliado.
 */
/**
 * O usuário pode colar só os parâmetros ("matt_tool=1&matt_word=x") ou o link inteiro gerado
 * no portal de afiliados (https://www.mercadolivre.com.br/social/x?matt_word=x&matt_tool=1&forceInApp=true&ref=...).
 * Do link inteiro aproveitamos só os parâmetros de rastreio; forceInApp/ref são lixo da página social.
 */
export function normalizeAffiliateSuffix(raw?: string): string {
  const s = (raw || '').trim().replace(/^[?&]+/, '');
  if (!s || !/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    for (const k of ['forceInApp', 'ref']) u.searchParams.delete(k);
    return u.searchParams.toString();
  } catch { return ''; }
}

export function toAffiliateUrl(url: string, suffix?: string): string {
  const s = normalizeAffiliateSuffix(suffix);
  if (!s) return url;
  try {
    const u = new URL(url);
    for (const pair of s.split('&')) {
      const [k, ...rest] = pair.split('=');
      if (k) u.searchParams.set(k, rest.join('='));
    }
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + s;
  }
}
