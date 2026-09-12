import crypto from 'node:crypto';
import { MarketplaceAdapter } from './types';
import { getSecret } from '../services/settings';

/**
 * Cliente da Shopee Affiliate Open API (GraphQL).
 * Endpoint: https://open-api.affiliate.shopee.com.br/graphql
 * Autenticação: header "SHA256 Credential={appId}, Timestamp={ts}, Signature={sha256(appId+ts+payload+secret)}".
 * O offerLink devolvido já é o link de afiliado da conta dona do App ID.
 */

const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

// TRENDING ("mais procurados"): a API da Shopee não expõe buscas, então usa a ordem de mais vendidos.
export type ShopeeSort = 'SALES' | 'COMMISSION' | 'RELEVANCE' | 'TRENDING';
// Enum numérico da API: 1 relevância, 2 mais vendidos, 3 preço desc, 4 preço asc, 5 maior comissão.
const SORT_CODE: Record<ShopeeSort, number> = { RELEVANCE: 1, SALES: 2, COMMISSION: 5, TRENDING: 2 };

export type ShopeeSearch = {
  keyword?: string;
  categoryId?: number;
  sort?: ShopeeSort;
  limit?: number;
  page?: number;
};

export type ShopeeOffer = {
  itemId: string;
  title: string;
  imageUrl?: string;
  price?: number;
  oldPrice?: number;
  discountPercent?: number;
  commissionRate?: number;  // em %, ex.: 12.5
  commissionValue?: number; // R$ estimado que o afiliado ganha por venda
  sales?: number;
  rating?: number;
  shopName?: string;
  productUrl: string;
  affiliateUrl: string;
  marketplace?: 'SHOPEE' | 'MERCADO_LIVRE'; // preenchido pela busca (útil quando a regra mistura os dois)
};

async function credentials() {
  const [appId, secret] = await Promise.all([getSecret('SHOPEE_APP_ID'), getSecret('SHOPEE_SECRET')]);
  if (!appId || !secret) throw new Error('Shopee não configurada: salve App ID e Secret em Configurações.');
  return { appId, secret };
}

async function graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { appId, secret } = await credentials();
  const payload = JSON.stringify({ query, variables });
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha256').update(`${appId}${ts}${payload}${secret}`).digest('hex');
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${signature}`
    },
    body: payload
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopee respondeu ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
  if (data.errors?.length) {
    const m = data.errors[0]?.message || 'erro desconhecido';
    const code = data.errors[0]?.extensions?.code;
    if (code === 10020 || /signature/i.test(m)) throw new Error('Shopee recusou a assinatura: confira App ID e Secret em Configurações.');
    throw new Error(`Shopee: ${m}`);
  }
  return data.data as T;
}

const QUERY = `
query Ofertas($keyword: String, $productCatId: Int, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, productCatId: $productCatId, sortType: $sortType, page: $page, limit: $limit) {
    nodes {
      itemId productName imageUrl priceMin priceMax priceDiscountRate
      commissionRate commission sales ratingStar shopName productLink offerLink
    }
    pageInfo { page limit hasNextPage }
  }
}`;

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

function normalize(n: any): ShopeeOffer | null {
  const productUrl = n.productLink || '';
  const affiliateUrl = n.offerLink || productUrl;
  if (!productUrl || !n.itemId) return null;
  const price = num(n.priceMin);
  const rate = num(n.priceDiscountRate); // percentual de desconto informado pela Shopee
  let oldPrice: number | undefined;
  let discountPercent: number | undefined;
  if (price && rate && rate > 0 && rate < 100) {
    discountPercent = Math.round(rate);
    oldPrice = Math.round((price / (1 - rate / 100)) * 100) / 100;
  } else {
    const max = num(n.priceMax);
    if (price && max && max > price) { oldPrice = max; discountPercent = Math.round((1 - price / max) * 100); }
  }
  // commissionRate chega como fração ("0.12") em algumas contas e como percentual em outras.
  const cr = num(n.commissionRate);
  const commissionRate = cr === undefined ? undefined : cr <= 1 ? Math.round(cr * 10000) / 100 : Math.round(cr * 100) / 100;
  // A Shopee manda o valor absoluto em "commission"; se vier vazio, estima pelo preço.
  const apiCommission = num(n.commission);
  const commissionValue = apiCommission && apiCommission > 0
    ? Math.round(apiCommission * 100) / 100
    : price !== undefined && commissionRate !== undefined ? Math.round(price * commissionRate) / 100 : undefined;
  return {
    itemId: String(n.itemId),
    title: String(n.productName || 'Produto Shopee').slice(0, 200),
    imageUrl: n.imageUrl || undefined,
    price, oldPrice, discountPercent,
    commissionRate, commissionValue,
    sales: num(n.sales),
    rating: num(n.ratingStar),
    shopName: n.shopName || undefined,
    productUrl, affiliateUrl
  };
}

/** Busca ofertas por palavra-chave e/ou categoria, ordenadas por vendas ou comissão. */
export async function searchShopeeOffers(s: ShopeeSearch): Promise<ShopeeOffer[]> {
  const keyword = (s.keyword || '').trim() || undefined;
  const productCatId = s.categoryId ? Number(s.categoryId) : undefined;
  if (!keyword && !productCatId) throw new Error('Informe uma palavra-chave ou categoria para buscar na Shopee.');
  const variables = {
    keyword, productCatId,
    sortType: SORT_CODE[s.sort || 'SALES'],
    page: s.page || 1,
    limit: Math.min(Math.max(s.limit || 10, 1), 50)
  };
  const data = await graphql<{ productOfferV2: { nodes: any[] } }>(QUERY, variables);
  return (data?.productOfferV2?.nodes || []).map(normalize).filter((x): x is ShopeeOffer => !!x);
}

/**
 * "Mais vendidos" e "maior comissão" numa lista só: consulta as duas ordenações,
 * junta sem repetir e prioriza quem aparece nas duas.
 */
export async function searchShopeeBest(s: Omit<ShopeeSearch, 'sort'> & { sort?: ShopeeSort | 'BOTH' }): Promise<ShopeeOffer[]> {
  const limit = s.limit || 10;
  if (s.sort && s.sort !== 'BOTH') return searchShopeeOffers({ ...s, sort: s.sort, limit });
  const [bySales, byCommission] = await Promise.all([
    searchShopeeOffers({ ...s, sort: 'SALES', limit }),
    searchShopeeOffers({ ...s, sort: 'COMMISSION', limit })
  ]);
  const score = new Map<string, { offer: ShopeeOffer; score: number }>();
  const add = (list: ShopeeOffer[]) => list.forEach((o, i) => {
    const cur = score.get(o.itemId);
    const pts = list.length - i; // primeiro da lista vale mais
    if (cur) cur.score += pts; else score.set(o.itemId, { offer: o, score: pts });
  });
  add(bySales); add(byCommission);
  return [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.offer);
}

// ---------- Relatório de conversões (vendas e comissões da conta) ----------

export type ShopeeSale = {
  conversionId: string;
  orderId: string;
  purchaseTime: Date;
  status: 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'UNPAID' | 'OTHER';
  itemId: string;
  itemName: string;
  imageUrl?: string;
  qty: number;
  itemPrice?: number;
  commission: number; // R$ da comissão deste item
};

// scrollId só entra na query quando existe: a API recusa o argumento com valor nulo.
const conversionQuery = (withScroll: boolean) => `
query Conversoes($start: Int64, $end: Int64, $limit: Int${withScroll ? ', $scrollId: String' : ''}) {
  conversionReport(purchaseTimeStart: $start, purchaseTimeEnd: $end, limit: $limit${withScroll ? ', scrollId: $scrollId' : ''}) {
    nodes {
      conversionId purchaseTime totalCommission
      orders { orderId orderStatus items { itemId itemName itemPrice qty imageUrl itemTotalCommission displayItemStatus } }
    }
    pageInfo { hasNextPage scrollId }
  }
}`;

function normStatus(s: unknown): ShopeeSale['status'] {
  const t = String(s || '').toUpperCase();
  if (t.includes('COMPLET')) return 'COMPLETED';
  if (t.includes('CANCEL')) return 'CANCELLED';
  if (t.includes('UNPAID')) return 'UNPAID';
  if (t.includes('PEND')) return 'PENDING';
  return 'OTHER';
}

/** Todas as vendas atribuídas à conta no período (pagina até acabar; o scrollId vale 30 s). */
export async function fetchShopeeSales(start: Date, end: Date): Promise<ShopeeSale[]> {
  const out: ShopeeSale[] = [];
  let scrollId: string | undefined;
  for (let page = 0; page < 40; page++) {
    const data = await graphql<{ conversionReport: { nodes: any[]; pageInfo: { hasNextPage: boolean; scrollId?: string } } }>(
      conversionQuery(!!scrollId),
      // Int64 nesta API só aceita como string no JSON de variáveis.
      { start: String(Math.floor(start.getTime() / 1000)), end: String(Math.floor(end.getTime() / 1000)), limit: 100, ...(scrollId ? { scrollId } : {}) }
    );
    const rep = data?.conversionReport;
    for (const n of rep?.nodes || []) {
      const purchaseTime = new Date(Number(n.purchaseTime) * 1000);
      for (const o of n.orders || []) {
        for (const it of o.items || []) {
          out.push({
            conversionId: String(n.conversionId),
            orderId: String(o.orderId || ''),
            purchaseTime,
            status: normStatus(it.displayItemStatus || o.orderStatus),
            itemId: String(it.itemId || ''),
            itemName: String(it.itemName || 'Produto'),
            imageUrl: it.imageUrl || undefined,
            qty: Number(it.qty) || 1,
            itemPrice: num(it.itemPrice),
            commission: num(it.itemTotalCommission) ?? 0
          });
        }
      }
    }
    if (!rep?.pageInfo?.hasNextPage || !rep.pageInfo.scrollId) break;
    scrollId = rep.pageInfo.scrollId;
  }
  return out;
}

/** Adapter mantido para compatibilidade com o restante do código. */
export class ShopeeAdapter implements MarketplaceAdapter {
  async createAffiliateUrl(input: { productUrl: string; externalId?: string; tag?: string }) {
    return input.productUrl;
  }
  async getProduct(input: { url?: string; externalId?: string }) {
    if (!input.url) throw new Error('URL do produto é obrigatória no modo MVP.');
    return { title: 'Produto Shopee', productUrl: input.url };
  }
}

/**
 * Transforma qualquer URL da Shopee (página de cupons, categoria, loja...) em link curto de afiliado
 * (s.shopee.com.br/...), para a comissão contar mesmo em páginas que não são de produto.
 */
export async function generateShopeeShortLink(originUrl: string, subIds: string[] = []): Promise<string> {
  const MUTATION = `
mutation Curto($originUrl: String!, $subIds: [String!]) {
  generateShortLink(input: { originUrl: $originUrl, subIds: $subIds }) { shortLink }
}`;
  const data = await graphql<{ generateShortLink: { shortLink: string } }>(MUTATION, { originUrl, subIds });
  const link = data?.generateShortLink?.shortLink;
  if (!link) throw new Error('Shopee não devolveu o link curto.');
  return link;
}
