import { getSecret } from '../services/settings';
import type { ShopeeOffer } from './shopee';

/**
 * Amazon (Programa de Associados da Amazon.com.br).
 *
 * Link de afiliado: qualquer link da Amazon com o parâmetro `tag=SUA-TAG-20` paga a comissão.
 * Isso funciona desde o primeiro dia, sem API: basta salvar a tag (AMAZON_PARTNER_TAG) em
 * Configurações. Captura de ofertas e cadastro por link usam só isso.
 *
 * Busca de produtos: Creators API (substituiu a PA-API 5.0, desligada em 15/05/2026).
 *   - credenciais v3.x (Login with Amazon) criadas em Associates Central → Ferramentas → Creators API;
 *     o Brasil fica na região NA (token em api.amazon.com).
 *   - a Amazon só libera a API depois de vendas qualificadas recentes (hoje: 10 em 30 dias); sem isso
 *     o token sai, mas a busca devolve erro de acesso.
 *   - token client_credentials vale ~1 h (fica em cache); SearchItems/GetItems devolvem até 10 itens.
 * A API não informa a comissão; ela depende da categoria (tabela no portal de associados).
 */

const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const API = 'https://creatorsapi.amazon/catalog/v1';
const MARKETPLACE = 'www.amazon.com.br';
const SITE = 'https://www.amazon.com.br';

const RESOURCES = [
  'itemInfo.title',
  'images.primary.large',
  'offersV2.listings.price',
  'offersV2.listings.merchantInfo'
];

// SALES/TRENDING/COMMISSION: a Amazon não ordena por vendas nem comissão; "Featured" é o destaque dela.
export type AmazonSort = 'SALES' | 'RELEVANCE' | 'TRENDING' | 'COMMISSION' | 'BOTH';
const SORT_BY: Record<AmazonSort, string> = { SALES: 'Featured', TRENDING: 'Featured', COMMISSION: 'Featured', BOTH: 'Featured', RELEVANCE: 'Relevance' };

export type AmazonSearch = {
  keyword?: string;
  searchIndex?: string; // categoria da Amazon (ex.: Electronics); padrão All
  sort?: AmazonSort;
  limit?: number;
  page?: number;
  minDiscount?: number;
};

/** ASIN (10 caracteres) de links como /dp/B0XXXX, /gp/product/B0XXXX, /gp/aw/d/B0XXXX. */
export function extractAsin(url: string): string | null {
  const m = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|\/exec\/obidos\/asin\/)([A-Z0-9]{10})(?=[/?#&]|$)/i.exec(url);
  return m ? m[1].toUpperCase() : null;
}

export const isAmazonUrl = (url: string) => /(^|\/\/|\.)(amazon\.com\.br|amazon\.com|amzn\.to|amzn\.com|a\.co)(\/|$|\?)/i.test(url);

/** Link curto (amzn.to, a.co) → link completo, seguindo os redirecionamentos. */
export async function expandAmazonUrl(url: string): Promise<string> {
  if (!/amzn\.to|a\.co\/|amzn\.com/i.test(url)) return url;
  let current = url;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(current, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } }).catch(() => null);
    const next = r?.headers.get('location');
    if (!next) break;
    current = new URL(next, current).toString();
    if (/amazon\.com/i.test(current) && extractAsin(current)) break;
  }
  return current;
}

/** Tag salva pelo usuário; aceita "fulano-20" ou um link inteiro que já tenha ?tag=fulano-20. */
export async function amazonTag(): Promise<string> {
  const raw = (await getSecret('AMAZON_PARTNER_TAG') || '').trim();
  return normalizeAmazonTag(raw);
}

export function normalizeAmazonTag(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const fromUrl = /[?&]tag=([^&#\s]+)/i.exec(s);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  return s.replace(/^tag=/i, '');
}

/**
 * Link de afiliado: com ASIN vira o link limpo amazon.com.br/dp/ASIN?tag=..., sem o rastreio de
 * outro afiliado (ref, linkCode, ascsubtag...). Sem ASIN (busca, loja), só troca a tag.
 */
export function amazonAffiliateUrl(url: string, tag: string): string {
  const asin = extractAsin(url);
  if (asin) return tag ? `${SITE}/dp/${asin}?tag=${encodeURIComponent(tag)}` : `${SITE}/dp/${asin}`;
  if (!tag) return url;
  try {
    const u = new URL(url);
    for (const k of ['tag', 'ascsubtag', 'linkCode', 'linkId', 'ref_', 'camp', 'creative']) u.searchParams.delete(k);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch { return url; }
}

async function credentials() {
  const [id, secret, tag] = await Promise.all([getSecret('AMAZON_CREDENTIAL_ID'), getSecret('AMAZON_CREDENTIAL_SECRET'), amazonTag()]);
  if (!tag) throw new Error('Amazon não configurada: salve sua tag de associado (ex.: seunome-20) em Configurações.');
  if (!id || !secret) throw new Error('Busca na Amazon precisa das credenciais da Creators API (Associates Central → Ferramentas → Creators API). Sem elas, cole os links da Amazon em Capturar ofertas.');
  return { id, secret, tag };
}

let tokenCache: { key: string; token: string; until: number } | null = null;

async function accessToken(id: string, secret: string): Promise<string> {
  const key = `${id}:${secret.slice(-6)}`;
  if (tokenCache && tokenCache.key === key && tokenCache.until > Date.now()) return tokenCache.token;
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'creatorsapi::default' })
  });
  const data: any = await r.json().catch(() => null);
  if (!r.ok || !data?.access_token) {
    const why = data?.error_description || data?.error || `HTTP ${r.status}`;
    throw new Error(`Amazon recusou as credenciais da Creators API (${why}). Confira o Credential ID e o Secret em Configurações.`);
  }
  tokenCache = { key, token: data.access_token, until: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 120) * 1000 };
  return data.access_token;
}

async function call(operation: 'searchItems' | 'getItems', body: Record<string, unknown>): Promise<any> {
  const { id, secret, tag } = await credentials();
  const token = await accessToken(id, secret);
  const r = await fetch(`${API}/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({ partnerTag: tag, marketplace: MARKETPLACE, resources: RESOURCES, ...body })
  });
  const data: any = await r.json().catch(() => null);
  if (r.status === 401) tokenCache = null;
  if (!r.ok) {
    const msg = data?.errors?.[0]?.message || data?.message || data?.error || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) {
      throw new Error(`Amazon negou o acesso à Creators API (${msg}). A Amazon só libera a busca depois de vendas recentes pelo seu link; até lá, use Capturar ofertas com links da Amazon.`);
    }
    if (r.status === 429) throw new Error('Amazon: muitas buscas seguidas (limite da Creators API). Tente de novo em alguns minutos.');
    throw new Error(`Falha na busca da Amazon: ${String(msg).slice(0, 200)}`);
  }
  return data;
}

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

/** Item da Creators API → oferta no formato comum do sistema. Campos ausentes ficam vazios. */
function normalize(item: any, tag: string): ShopeeOffer | null {
  const asin = item?.asin;
  const title = item?.itemInfo?.title?.displayValue;
  if (!asin || !title) return null;
  const listing = (item?.offersV2?.listings || [])[0];
  const price = num(listing?.price?.money?.amount);
  const basis = num(listing?.price?.savingBasis?.money?.amount);
  const oldPrice = basis && price && basis > price ? basis : undefined;
  const pct = num(listing?.price?.savings?.percentage) ?? (oldPrice && price ? Math.round((1 - price / oldPrice) * 100) : undefined);
  const productUrl = item?.detailPageURL || `${SITE}/dp/${asin}`;
  return {
    itemId: asin,
    title,
    imageUrl: item?.images?.primary?.large?.url || item?.images?.primary?.medium?.url,
    price,
    oldPrice,
    discountPercent: pct ? Math.round(pct) : undefined,
    shopName: listing?.merchantInfo?.name,
    productUrl: `${SITE}/dp/${asin}`,
    affiliateUrl: amazonAffiliateUrl(productUrl, tag),
    marketplace: 'AMAZON'
  };
}

/** Busca por palavra-chave. Pede de 10 em 10 (limite da Amazon) até completar `limit`. */
export async function searchAmazonOffers(s: AmazonSearch): Promise<ShopeeOffer[]> {
  if (!s.keyword?.trim()) throw new Error('A busca da Amazon precisa de uma palavra-chave.');
  const tag = await amazonTag();
  const limit = Math.max(1, Math.min(s.limit || 10, 30));
  const pages = Math.ceil(limit / 10);
  const firstPage = ((s.page || 1) - 1) * pages + 1;
  const out: ShopeeOffer[] = [];
  const seen = new Set<string>();
  for (let p = firstPage; p < firstPage + pages && p <= 10 && out.length < limit; p++) {
    const data = await call('searchItems', {
      keywords: s.keyword.trim(),
      searchIndex: s.searchIndex || 'All',
      itemCount: 10,
      itemPage: p,
      sortBy: SORT_BY[s.sort || 'SALES'],
      ...(s.minDiscount ? { minSavingPercent: Math.min(99, Math.max(1, Math.round(s.minDiscount))) } : {})
    });
    const items: any[] = data?.searchResult?.items || [];
    for (const it of items) {
      const o = normalize(it, tag);
      if (o && !seen.has(o.itemId)) { seen.add(o.itemId); out.push(o); }
    }
    if (items.length < 10) break;
  }
  return out.slice(0, limit);
}

/** Um produto pelo ASIN (cadastro por link). Sem credenciais da API, devolve null. */
export async function fetchAmazonItem(asin: string): Promise<ShopeeOffer | null> {
  const [id, secret] = await Promise.all([getSecret('AMAZON_CREDENTIAL_ID'), getSecret('AMAZON_CREDENTIAL_SECRET')]);
  if (!id || !secret) return null;
  const tag = await amazonTag();
  const data = await call('getItems', { itemIds: [asin], itemIdType: 'ASIN' });
  const item = (data?.itemsResult?.items || [])[0];
  return item ? normalize(item, tag) : null;
}
