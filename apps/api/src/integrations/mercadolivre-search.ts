import { getSecret } from '../services/settings';
import { getMercadoLivreAccessToken } from './mercadolivre-oauth';
import type { ShopeeOffer } from './shopee';

/**
 * Busca de ofertas no Mercado Livre pela API oficial.
 *
 * Desde 2025 o ML devolve 403 ("forbidden") em /sites/MLB/search e em /items/{id} para apps
 * comuns de afiliado — o token está válido, mas esses recursos ficaram restritos. O que segue
 * aberto (testado em 2026-09-06 com a conta do usuário):
 *   - /sites/MLB/domain_discovery/search  palavra-chave -> categorias prováveis
 *   - /highlights/MLB/category/X           mais vendidos da categoria (ids de produto do catálogo)
 *   - /products/{id}                       nome e fotos do produto do catálogo
 *   - /products/{id}/items                 anúncios daquele produto, com preço e preço "de"
 *   - /products/search                     busca no catálogo por texto (mas a maioria dos
 *                                          produtos que devolve está sem anúncio ativo)
 * Então a busca por palavra-chave descobre a(s) categoria(s) e pega os mais vendidos delas;
 * o catálogo por texto fica só como último recurso. Cada oferta = produto de catálogo + anúncio
 * mais barato. O link é a página do catálogo (mercadolivre.com.br/p/ID), que já mostra a melhor
 * oferta. A comissão NÃO existe na API do ML; o link de afiliado é a URL com o parâmetro de
 * rastreio do usuário (ML_AFFILIATE_SUFFIX, ex.: "matt_tool=SEU_ID&matt_word=SEU_NOME").
 */

// TRENDING: mais vendidos da categoria, com os que batem nos termos mais buscados (/trends) na frente.
export type MlSort = 'SALES' | 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'TRENDING';

export type MlSearch = {
  userId: string;
  keyword?: string;
  categoryId?: string;   // ex.: MLB1051
  sort?: MlSort;
  limit?: number;
  page?: number;
  minDiscount?: number;
};

const API = 'https://api.mercadolibre.com';
const MAX_CATEGORIES_PER_KEYWORD = 3;

/**
 * Normaliza o que o usuário salvou em "parâmetro de afiliado". Aceita:
 *   - só os parâmetros:  matt_tool=39267530&matt_word=fulano
 *   - o link inteiro copiado do programa de afiliados do ML
 *     (https://www.mercadolivre.com.br/social/fulano?matt_word=fulano&matt_tool=392...&forceInApp=true&ref=...#origin=copy_link)
 * Do link inteiro só interessam os parâmetros de rastreio; forceInApp/ref são lixo da página social.
 */
export function normalizeAffiliateSuffix(raw?: string): string {
  const s = (raw || '').trim().replace(/^[?&]+/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    for (const k of ['forceInApp', 'ref']) u.searchParams.delete(k);
    return u.searchParams.toString();
  } catch { return ''; }
}

/** Aplica o parâmetro de afiliado à URL (mesma regra do toAffiliateUrl do painel). */
export function applyAffiliateSuffix(url: string, suffix?: string) {
  const s = normalizeAffiliateSuffix(suffix);
  if (!s) return url;
  try {
    const u = new URL(url);
    for (const pair of s.split('&')) { const [k, ...rest] = pair.split('='); if (k) u.searchParams.set(k, rest.join('=')); }
    return u.toString();
  } catch { return url + (url.includes('?') ? '&' : '?') + s; }
}

export const catalogUrl = (productId: string) => `https://www.mercadolivre.com.br/p/${productId}`;

/** Foto do catálogo vem como "...-F.jpg" (grande). Garante https. */
const picture = (p?: any) => { const u: string | undefined = p?.url || p?.secure_url; return u ? u.replace(/^http:/, 'https:') : undefined; };

async function mlGet(path: string, token: string): Promise<{ status: number; data: any }> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
  let data: any = null; try { data = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, data };
}

function explain(status: number, recurso: string): Error {
  if (status === 401) return new Error('O Mercado Livre recusou o token. Reconecte a conta em Configurações.');
  if (status === 403) return new Error(`O Mercado Livre bloqueou o acesso a "${recurso}" para este aplicativo (403). A conta está conectada; o bloqueio é do lado do Mercado Livre.`);
  if (status === 429) return new Error('O Mercado Livre limitou as chamadas por enquanto (429). Tente de novo em alguns minutos.');
  return new Error(`Mercado Livre respondeu ${status} em ${recurso}.`);
}

async function mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx]); }
  }));
  return out;
}

type CatalogProduct = { id: string; name: string; imageUrl?: string };

/**
 * Termos mais buscados no Mercado Livre agora (site inteiro ou de uma categoria).
 * Endpoint /trends/MLB[/categoria]; testado aberto para o app em 2026-09-08.
 */
export async function trendingKeywords(userId: string, categoryId?: string, limit = 30): Promise<string[]> {
  const token = await getMercadoLivreAccessToken(userId);
  const r = await mlGet(`/trends/MLB${categoryId ? '/' + encodeURIComponent(categoryId) : ''}`, token);
  if (r.status === 404) throw new Error(`Categoria "${categoryId}" não existe no Mercado Livre.`);
  if (r.status !== 200) throw explain(r.status, 'termos mais buscados');
  const out: string[] = [];
  for (const t of Array.isArray(r.data) ? r.data : []) { const k = String(t?.keyword || '').trim(); if (k && !out.includes(k)) out.push(k); }
  return out.slice(0, limit);
}

/** Palavras com 3+ letras do termo, para casar com o título do produto. */
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 3);

/** Quantos termos de tendência o título atende (todas as palavras do termo presentes). */
function trendScore(title: string, trends: string[][]): number {
  const t = words(title); let n = 0;
  for (const term of trends) if (term.length && term.every(w => t.includes(w))) n++;
  return n;
}

/**
 * Categorias prováveis para a palavra-chave. O ML devolve sempre "Águas Minerais" em primeiro
 * (parece um padrão da API quando não tem certeza), então ela só fica se for a única opção.
 */
async function categoriesFor(token: string, keyword: string): Promise<string[]> {
  const r = await mlGet(`/sites/MLB/domain_discovery/search?q=${encodeURIComponent(keyword)}&limit=${MAX_CATEGORIES_PER_KEYWORD + 1}`, token);
  if (r.status !== 200 || !Array.isArray(r.data)) return [];
  const all = r.data.filter((d: any) => d?.category_id).map((d: any) => ({ id: String(d.category_id), domain: String(d.domain_id || '') }));
  const semAgua = all.filter(d => d.domain !== 'MLB-MINERAL_WATERS');
  const ids = (semAgua.length ? semAgua : all).map(d => d.id);
  return [...new Set(ids)].slice(0, MAX_CATEGORIES_PER_KEYWORD);
}

/** Ids dos mais vendidos da categoria (até 20, já em ordem de vendas). */
async function bestSellerIds(token: string, categoryId: string): Promise<string[]> {
  const r = await mlGet(`/highlights/MLB/category/${encodeURIComponent(categoryId)}`, token);
  if (r.status === 404) throw new Error(`Categoria "${categoryId}" não existe no Mercado Livre. Use o código da categoria (ex.: MLB1051).`);
  if (r.status !== 200) throw explain(r.status, 'mais vendidos da categoria');
  return (r.data?.content || []).filter((x: any) => x?.type === 'PRODUCT' && x?.id).map((x: any) => String(x.id));
}

async function productMeta(token: string, id: string): Promise<CatalogProduct | null> {
  const p = await mlGet(`/products/${id}`, token);
  if (p.status !== 200 || !p.data?.id) return null;
  return { id, name: String(p.data.name || 'Produto Mercado Livre').slice(0, 200), imageUrl: picture(p.data.pictures?.[0]) };
}

/** Produtos do catálogo por texto (último recurso: muitos vêm sem anúncio ativo). */
async function searchCatalog(token: string, keyword: string, limit: number, offset: number): Promise<CatalogProduct[]> {
  const p = new URLSearchParams({ status: 'active', site_id: 'MLB', q: keyword, limit: String(limit), offset: String(offset) });
  const r = await mlGet(`/products/search?${p}`, token);
  if (r.status !== 200) throw explain(r.status, 'busca no catálogo');
  return (r.data?.results || [])
    .filter((x: any) => x?.id && x?.status !== 'inactive')
    .map((x: any): CatalogProduct => ({ id: String(x.id), name: String(x.name || 'Produto Mercado Livre').slice(0, 200), imageUrl: picture(x.pictures?.[0]) }));
}

/** Intercala listas (1º de cada, depois 2º de cada...), sem repetir id. */
function interleave(lists: string[][]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) { const id = l[i]; if (id && !seen.has(id)) { seen.add(id); out.push(id); } }
  return out;
}

type BestItem = { itemId: string; price: number; oldPrice?: number; officialStore?: boolean };

/** Entre os anúncios do produto, pega o mais barato (novo). */
async function cheapestItem(token: string, productId: string): Promise<BestItem | null> {
  const r = await mlGet(`/products/${productId}/items?limit=50`, token);
  if (r.status !== 200) return null;
  let best: BestItem | null = null;
  for (const it of r.data?.results || []) {
    const price = Number(it?.price); if (!it?.item_id || !price || price <= 0) continue;
    if (it.condition && it.condition !== 'new') continue;
    if (!best || price < best.price) {
      const oldPrice = Number(it.original_price) || undefined;
      best = { itemId: String(it.item_id), price, oldPrice: oldPrice && oldPrice > price ? oldPrice : undefined, officialStore: !!it.official_store_id };
    }
  }
  return best;
}

export async function searchMercadoLivreOffers(s: MlSearch): Promise<ShopeeOffer[]> {
  const keyword = (s.keyword || '').trim();
  const category = (s.categoryId || '').trim();
  if (!keyword && !category) throw new Error('Informe uma palavra-chave ou categoria para buscar no Mercado Livre.');

  const [token, suffix] = await Promise.all([getMercadoLivreAccessToken(s.userId), getSecret('ML_AFFILIATE_SUFFIX')]);
  const limit = Math.min(Math.max(s.limit || 10, 1), 50);
  const page = Math.max(s.page || 1, 1);
  // Pede um pouco mais que o pedido: alguns produtos estão sem anúncio ativo ou sem preço "de".
  const fetchLimit = Math.min(s.minDiscount ? limit * 2 : limit + 3, 50);
  const from = (page - 1) * fetchLimit;

  // 1) ids dos produtos candidatos, em ordem de vendas
  let ids: string[];
  const cats = category ? [category] : await categoriesFor(token, keyword);
  if (category) ids = await bestSellerIds(token, category);
  else {
    const lists = await mapLimit(cats, 3, c => bestSellerIds(token, c).catch(() => [] as string[]));
    ids = interleave(lists);
  }
  // "Mais procurados": termos mais buscados dessas categorias, para puxar para a frente quem bate neles.
  const trends: string[][] = s.sort === 'TRENDING'
    ? (await mapLimit(cats, 3, c => trendingKeywords(s.userId, c).catch(() => [] as string[]))).flat().map(words)
    : [];

  // 2) metadados (nome, foto) só da página pedida
  let products: CatalogProduct[];
  if (ids.length) {
    const slice = ids.slice(from, from + fetchLimit);
    products = (await mapLimit(slice, 5, id => productMeta(token, id).catch(() => null))).filter((x): x is CatalogProduct => !!x);
  } else if (keyword) {
    products = await searchCatalog(token, keyword, fetchLimit, from);
  } else products = [];
  if (!products.length) return [];

  // 3) anúncio mais barato de cada produto
  const items = await mapLimit(products, 5, p => cheapestItem(token, p.id).catch(() => null));

  const offers: ShopeeOffer[] = [];
  products.forEach((p, i) => {
    const it = items[i]; if (!it) return; // produto sem anúncio ativo
    const discountPercent = it.oldPrice ? Math.round((1 - it.price / it.oldPrice) * 100) : undefined;
    if (s.minDiscount && s.minDiscount > 0 && (discountPercent || 0) < s.minDiscount) return;
    const url = catalogUrl(p.id);
    offers.push({
      itemId: p.id, // id do produto de catálogo (estável entre anúncios)
      title: p.name,
      imageUrl: p.imageUrl,
      price: it.price, oldPrice: it.oldPrice, discountPercent,
      commissionRate: undefined, commissionValue: undefined, // o ML não informa comissão por API
      sales: undefined, rating: undefined,
      shopName: it.officialStore ? 'Loja oficial' : undefined,
      productUrl: url,
      affiliateUrl: applyAffiliateSuffix(url, suffix)
    });
  });

  if (s.sort === 'PRICE_ASC') offers.sort((a, b) => (a.price || 0) - (b.price || 0));
  else if (s.sort === 'PRICE_DESC') offers.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (s.sort === 'TRENDING' && trends.length) {
    // Ordenação estável: quem bate em mais termos buscados primeiro; empate mantém a ordem de vendas.
    const score = new Map(offers.map(o => [o.itemId, trendScore(o.title, trends)]));
    offers.sort((a, b) => (score.get(b.itemId) || 0) - (score.get(a.itemId) || 0));
  }
  // SALES/RELEVANCE: a lista já vem na ordem de mais vendidos do ML.
  return offers.slice(0, limit);
}
