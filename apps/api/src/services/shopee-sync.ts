import type { Product } from '@prisma/client';
import { prisma } from '../db';
import { searchShopeeBest, type ShopeeOffer, type ShopeeSort } from '../integrations/shopee';
import { searchMercadoLivreOffers } from '../integrations/mercadolivre-search';

/**
 * Regra "buscar no marketplace" gravada em Automation.rulesJson.shopeeSearch.
 * O nome do campo ficou por compatibilidade; `marketplace` escolhe Shopee (padrão) ou Mercado Livre.
 * `marketplaces` permite marcar os dois: a rodada é dividida entre eles e os resultados intercalados.
 */
export type SearchMarketplace = 'SHOPEE' | 'MERCADO_LIVRE';
export type ShopeeSearchRule = {
  marketplace?: SearchMarketplace;
  marketplaces?: SearchMarketplace[];
  keyword?: string;               // legado: um termo só
  keywords?: string[];            // vários nichos/termos; a busca roda em cada um e mistura
  categoryId?: number | string;   // Shopee: número; Mercado Livre: "MLB1051"
  sort?: ShopeeSort | 'BOTH';    // legado: um critério só
  sorts?: string[];              // vários critérios marcados; quem aparece bem em mais de um sobe
  limit?: number;
  minDiscount?: number;           // repassado ao ML para filtrar já na API
  keywordCursor?: number;         // nº da rodada (o robô informa): escolhe o bloco de termos do rodízio
};

/** Quantos termos entram por rodada: ~3 produtos por termo, no mínimo 3 termos. */
export function keywordWindowSize(count: number, limit: number): number {
  return Math.min(count, Math.max(3, Math.ceil((limit || 10) / 3)));
}

/**
 * Termos desta rodada. Com muitos termos, buscar em todos a cada rodada faria sempre os primeiros
 * da lista vencerem. Então cada rodada usa um bloco de termos e a próxima avança na lista (rodízio),
 * até todos passarem. Sem `keywordCursor` (ex.: "Testar busca agora"), usa o bloco do início.
 */
export function keywordWindow(rule: ShopeeSearchRule): { terms: string[]; size: number; total: number } {
  const all = ruleKeywords(rule);
  const size = keywordWindowSize(all.length, rule.limit || 10);
  if (all.length <= size) return { terms: all, size, total: all.length };
  const round = Math.max(0, Math.floor(Number(rule.keywordCursor) || 0));
  const start = (round * size) % all.length;
  const rotated = [...all.slice(start), ...all.slice(0, start)];
  return { terms: rotated.slice(0, size), size, total: all.length };
}

/** Lista final de termos: `keywords` novo ou `keyword` legado, sem vazios nem repetidos. */
export function ruleKeywords(rule: ShopeeSearchRule): string[] {
  const all = [...(Array.isArray(rule.keywords) ? rule.keywords : []), rule.keyword || ''].map(k => String(k).trim()).filter(Boolean);
  return [...new Set(all.map(k => k.toLowerCase()))].map(lower => all.find(k => k.toLowerCase() === lower)!);
}

const SORTS = ['TRENDING', 'SALES', 'COMMISSION', 'RELEVANCE', 'BOTH'];
/** Critérios de ordenação da regra: `sorts` novo ou `sort` legado; padrão "mais procurados". */
export function ruleSorts(rule: ShopeeSearchRule): string[] {
  const list = (Array.isArray(rule.sorts) ? rule.sorts : []).map(String).filter(s => SORTS.includes(s));
  if (list.length) return [...new Set(list)];
  return [rule.sort && SORTS.includes(rule.sort) ? rule.sort : 'TRENDING'];
}

export function hasShopeeSearch(rules: any): rules is { shopeeSearch: ShopeeSearchRule } {
  const s = rules?.shopeeSearch;
  return !!s && (ruleKeywords(s).length > 0 || !!s.categoryId);
}

export const marketplaceLabel = (m?: string) => (m === 'MERCADO_LIVRE' ? 'Mercado Livre' : 'Shopee');

/** Marketplaces da regra: `marketplaces` novo (um ou os dois) ou `marketplace` legado; padrão Shopee. */
export function ruleMarketplaces(rule: ShopeeSearchRule): SearchMarketplace[] {
  const list = (Array.isArray(rule.marketplaces) ? rule.marketplaces : []).filter((m): m is SearchMarketplace => m === 'SHOPEE' || m === 'MERCADO_LIVRE');
  if (list.length) return [...new Set(list)];
  return [rule.marketplace === 'MERCADO_LIVRE' ? 'MERCADO_LIVRE' : 'SHOPEE'];
}

/** "Shopee", "Mercado Livre" ou "Shopee + Mercado Livre", para logs e tela. */
export const searchMarketplaceLabel = (rule: ShopeeSearchRule) => ruleMarketplaces(rule).map(marketplaceLabel).join(' + ');

/** Regra restrita a um marketplace só (sem categoria quando a original misturava os dois, pois o ID é de cada loja). */
function ruleFor(rule: ShopeeSearchRule, marketplace: SearchMarketplace, limit: number): ShopeeSearchRule {
  const mixed = ruleMarketplaces(rule).length > 1;
  return { ...rule, marketplace, marketplaces: undefined, limit, categoryId: mixed ? undefined : rule.categoryId };
}

/** Intercala listas (1º de cada, depois 2º de cada...) sem repetir item, até `limit`. */
function interleave<T extends { itemId?: string; id?: string }>(lists: T[][], limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const o = list[i];
      const key = o ? String(o.itemId ?? o.id) : '';
      if (o && !seen.has(key)) { seen.add(key); out.push(o); if (out.length >= limit) break; }
    }
  }
  return out;
}

/** "Cozinha, Pet Shop e Fitness" ou "categoria 100630", para logs e tela. */
export function describeSearch(rule: ShopeeSearchRule): string {
  const ks = ruleKeywords(rule);
  if (!ks.length) return `categoria ${rule.categoryId}`;
  // Com rodízio ativo, mostra os termos usados nesta rodada.
  if (rule.keywordCursor !== undefined) {
    const w = keywordWindow(rule);
    if (w.total > w.size) return `${w.terms.join(', ')} (rodízio: ${w.size} de ${w.total} termos)`;
  }
  if (ks.length <= 3) return ks.join(', ');
  return `${ks.slice(0, 3).join(', ')} +${ks.length - 3}`;
}

async function searchOneSort(userId: string, rule: ShopeeSearchRule, keyword: string | undefined, sort: string, limit: number, page: number): Promise<ShopeeOffer[]> {
  if (rule.marketplace === 'MERCADO_LIVRE') {
    // ML não tem comissão por API: "maior comissão" e "vendas + comissão" viram "mais vendidos".
    const s = sort === 'RELEVANCE' ? 'RELEVANCE' : sort === 'TRENDING' ? 'TRENDING' : 'SALES';
    return searchMercadoLivreOffers({ userId, keyword, categoryId: rule.categoryId ? String(rule.categoryId) : undefined, sort: s, limit, page, minDiscount: rule.minDiscount });
  }
  return searchShopeeBest({ keyword, categoryId: rule.categoryId ? Number(rule.categoryId) : undefined, sort: sort as ShopeeSort | 'BOTH', limit, page });
}

/**
 * Um termo, todos os critérios marcados. Com mais de um critério, consulta cada um e soma pontos
 * pela posição (1º da lista vale mais): produto que é ao mesmo tempo mais procurado, mais vendido
 * e de maior comissão fica na frente. Um critério que falhar não derruba os outros.
 */
async function searchOne(userId: string, rule: ShopeeSearchRule, keyword: string | undefined, limit: number, page: number): Promise<ShopeeOffer[]> {
  const sorts = [...new Set(ruleSorts(rule).map(s => rule.marketplace === 'MERCADO_LIVRE' && (s === 'COMMISSION' || s === 'BOTH') ? 'SALES' : s))];
  if (sorts.length === 1) return searchOneSort(userId, rule, keyword, sorts[0], limit, page);
  const lists = await Promise.all(sorts.map(s => searchOneSort(userId, rule, keyword, s, limit, page).catch(() => [] as ShopeeOffer[])));
  if (lists.every(l => !l.length)) await searchOneSort(userId, rule, keyword, sorts[0], limit, page); // devolve o erro real
  const score = new Map<string, { offer: ShopeeOffer; score: number }>();
  for (const list of lists) list.forEach((o, i) => {
    const pts = list.length - i;
    const cur = score.get(o.itemId);
    if (cur) cur.score += pts; else score.set(o.itemId, { offer: o, score: pts });
  });
  return [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.offer);
}

/**
 * Busca no marketplace da regra. Com vários termos, roda um por um e intercala os
 * resultados (1º de cada termo, depois 2º de cada...), para a linha não ficar só com o
 * primeiro nicho. Um termo que falhar não derruba os outros.
 */
export async function searchOffers(userId: string, rule: ShopeeSearchRule, page = 1): Promise<ShopeeOffer[]> {
  const limit = rule.limit || 10;
  const marketplaces = ruleMarketplaces(rule);
  if (marketplaces.length > 1) {
    // Os dois marcados: metade da rodada em cada um, resultados intercalados. Um que falhar não derruba o outro.
    const per = Math.max(3, Math.ceil(limit / marketplaces.length));
    const lists = await Promise.all(marketplaces.map(m => searchOffers(userId, ruleFor(rule, m, per), page).catch(() => [] as ShopeeOffer[])));
    if (lists.every(l => !l.length)) await searchOffers(userId, ruleFor(rule, marketplaces[0], per), page); // devolve o erro real
    return interleave(lists, limit);
  }
  const tag = (offers: ShopeeOffer[]) => offers.map(o => ({ ...o, marketplace: marketplaces[0] }));
  return tag(await searchOffersSingle(userId, { ...rule, marketplace: marketplaces[0], marketplaces: undefined }, limit, page));
}

/** Roda `fn` em cada item com no máximo `limit` execuções simultâneas, preservando a ordem. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function searchOffersSingle(userId: string, rule: ShopeeSearchRule, limit: number, page: number): Promise<ShopeeOffer[]> {
  const keywords = keywordWindow(rule).terms; // bloco de termos desta rodada (rodízio)
  if (keywords.length <= 1) return searchOne(userId, rule, keywords[0], limit, page);

  const perTerm = Math.max(3, Math.ceil(limit / keywords.length));
  // Consulta em lotes de 8 para não estourar o limite de requisições da Shopee.
  const results = await mapLimit(keywords, 8, k => searchOne(userId, rule, k, perTerm, page).catch(() => [] as ShopeeOffer[]));
  if (results.every(r => !r.length)) {
    // Todos falharam: refaz um para devolver o erro real ao usuário.
    await searchOne(userId, rule, keywords[0], perTerm, page);
  }
  const seen = new Set<string>();
  const merged: ShopeeOffer[] = [];
  for (let i = 0; i < perTerm && merged.length < limit; i++) {
    for (const list of results) {
      const o = list[i];
      if (o && !seen.has(o.itemId)) { seen.add(o.itemId); merged.push(o); if (merged.length >= limit) break; }
    }
  }
  return merged;
}

/**
 * Busca e grava/atualiza os produtos do usuário (foto, preço, comissão, vendas).
 * O mesmo item (externalId) é atualizado em vez de duplicado, então rodar a automação
 * todo dia mantém preço e comissão frescos. Devolve os produtos na ordem da busca.
 */
export async function syncShopeeProducts(userId: string, rule: ShopeeSearchRule, listId?: string | null, page = 1): Promise<Product[]> {
  const marketplaces = ruleMarketplaces(rule);
  if (marketplaces.length > 1) {
    // Os dois marcados: importa de cada um (cada qual na própria conta de afiliado) e intercala.
    const limit = rule.limit || 10;
    const per = Math.max(3, Math.ceil(limit / marketplaces.length));
    const lists = await Promise.all(marketplaces.map(m => syncShopeeProducts(userId, ruleFor(rule, m, per), listId, page).catch(() => [] as Product[])));
    if (lists.every(l => !l.length)) await syncShopeeProducts(userId, ruleFor(rule, marketplaces[0], per), listId, page); // devolve o erro real
    return interleave(lists, limit);
  }
  const marketplace = marketplaces[0];
  const offers = await searchOffers(userId, { ...rule, marketplace, marketplaces: undefined }, page);
  if (!offers.length) return [];

  const account = await prisma.affiliateAccount.upsert({
    where: { userId_marketplace: { userId, marketplace } },
    create: { userId, marketplace, displayName: marketplace === 'SHOPEE' ? 'Shopee Affiliate (Open API)' : 'Mercado Livre' },
    update: {}
  });

  const products: Product[] = [];
  for (const o of offers) {
    const data = toProductData(o);
    const existing = await prisma.product.findFirst({ where: { accountId: account.id, externalId: o.itemId } });
    const p = existing
      ? await prisma.product.update({ where: { id: existing.id }, data })
      : await prisma.product.create({ data: { ...data, accountId: account.id, marketplace, externalId: o.itemId } });
    if (listId) {
      await prisma.listProduct.upsert({ where: { listId_productId: { listId, productId: p.id } }, create: { listId, productId: p.id }, update: {} });
    }
    products.push(p);
  }
  return products;
}

function toProductData(o: ShopeeOffer) {
  const bits: string[] = [];
  if (o.sales) bits.push(`${o.sales.toLocaleString('pt-BR')} vendidos`);
  if (o.rating) bits.push(`⭐ ${o.rating.toFixed(1).replace('.', ',')}`);
  if (o.shopName) bits.push(o.shopName);
  return {
    title: o.title,
    description: bits.join(' · ') || null,
    imageUrl: o.imageUrl || null,
    productUrl: o.productUrl,
    affiliateUrl: o.affiliateUrl,
    price: o.price ?? null,
    oldPrice: o.oldPrice ?? null,
    discountPercent: o.discountPercent ?? null,
    commissionRate: o.commissionRate ?? null,
    commissionValue: o.commissionValue ?? null,
    active: true
  };
}
