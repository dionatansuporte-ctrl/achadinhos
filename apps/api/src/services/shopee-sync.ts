import { prisma } from '../db';
import { searchShopeeBest, type ShopeeOffer, type ShopeeSort } from '../integrations/shopee';
import { searchMercadoLivreOffers } from '../integrations/mercadolivre-search';

/**
 * Regra "buscar no marketplace" gravada em Automation.rulesJson.shopeeSearch.
 * O nome do campo ficou por compatibilidade; `marketplace` escolhe Shopee (padrão) ou Mercado Livre.
 */
export type ShopeeSearchRule = {
  marketplace?: 'SHOPEE' | 'MERCADO_LIVRE';
  keyword?: string;               // legado: um termo só
  keywords?: string[];            // vários nichos/termos; a busca roda em cada um e mistura
  categoryId?: number | string;   // Shopee: número; Mercado Livre: "MLB1051"
  sort?: ShopeeSort | 'BOTH';    // legado: um critério só
  sorts?: string[];              // vários critérios marcados; quem aparece bem em mais de um sobe
  limit?: number;
  minDiscount?: number;           // repassado ao ML para filtrar já na API
};

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

/** "Cozinha, Pet Shop e Fitness" ou "categoria 100630", para logs e tela. */
export function describeSearch(rule: ShopeeSearchRule): string {
  const ks = ruleKeywords(rule);
  if (!ks.length) return `categoria ${rule.categoryId}`;
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
  const keywords = ruleKeywords(rule);
  if (keywords.length <= 1) return searchOne(userId, rule, keywords[0], limit, page);

  const perTerm = Math.max(3, Math.ceil(limit / keywords.length));
  const results = await Promise.all(keywords.map(k => searchOne(userId, rule, k, perTerm, page).catch(() => [] as ShopeeOffer[])));
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
export async function syncShopeeProducts(userId: string, rule: ShopeeSearchRule, listId?: string | null, page = 1) {
  const offers = await searchOffers(userId, rule, page);
  if (!offers.length) return [];

  const marketplace = rule.marketplace === 'MERCADO_LIVRE' ? 'MERCADO_LIVRE' : 'SHOPEE';
  const account = await prisma.affiliateAccount.upsert({
    where: { userId_marketplace: { userId, marketplace } },
    create: { userId, marketplace, displayName: marketplace === 'SHOPEE' ? 'Shopee Affiliate (Open API)' : 'Mercado Livre' },
    update: {}
  });

  const products = [];
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
