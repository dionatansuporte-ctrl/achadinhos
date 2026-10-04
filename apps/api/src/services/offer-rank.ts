import type { ShopeeOffer } from '../integrations/shopee';
import { fetchShopeeSales } from '../integrations/shopee';
import { prisma } from '../db';

/**
 * Critérios de ordenação que não existem nas APIs das lojas: o robô busca normalmente
 * (mais vendidos/procurados) e reordena o resultado aqui.
 * - DEALS ("Melhores ofertas da hora"): maior desconto, pesando quanto já vendeu e a nota.
 * - BUYERS ("O que meus clientes compram"): parecido com o que já foi comprado pelos seus links
 *   (relatório de conversões da Shopee, 30 dias) e com o que os clientes pediram no WhatsApp.
 */
export const DERIVED_SORTS = ['DEALS', 'BUYERS'];

const STOP = new Set(['de', 'do', 'da', 'dos', 'das', 'com', 'para', 'pra', 'por', 'sem', 'em', 'no', 'na', 'um', 'uma', 'kit', 'novo', 'nova', 'original', 'promocao', 'oferta', 'envio', 'frete', 'gratis', 'unidade', 'unidades', 'pcs', 'pecas', 'peca', 'cor', 'tamanho', 'the', 'and', 'quero', 'cupom', 'numero', 'olha', 'encontrei', 'achei', 'tem', 'voce', 'algum', 'alguma', 'preciso', 'procuro', 'busca', 'buscar']);

function tokens(text: string): string[] {
  const words = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/);
  return [...new Set(words.filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
}

function discountOf(o: ShopeeOffer) {
  if (o.discountPercent) return o.discountPercent;
  return o.oldPrice && o.price && o.oldPrice > o.price ? Math.round((1 - o.price / o.oldPrice) * 100) : 0;
}

/** Desconto vale mais quando o produto já vende bem e tem nota boa (evita "90% OFF" de produto que ninguém compra). */
export function rankDeals(pool: ShopeeOffer[]): ShopeeOffer[] {
  const score = (o: ShopeeOffer) => discountOf(o) * Math.log10((o.sales || 0) + 10) * (o.rating ? Math.min(1, o.rating / 5) : 0.9);
  return pool.map((o, i) => ({ o, i, s: score(o) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.o);
}

type Interest = { at: number; items: Set<string>; words: Map<string, number> };
const INTEREST_TTL = 30 * 60_000;
const interestCache = new Map<string, Interest>();

/** Perfil do que os clientes compram e pedem (cache de 30 min por usuário). */
export async function buyerInterest(userId: string): Promise<Interest> {
  const cached = interestCache.get(userId);
  if (cached && Date.now() - cached.at < INTEREST_TTL) return cached;
  const since = new Date(Date.now() - 30 * 86_400_000);
  const items = new Set<string>();
  const words = new Map<string, number>();
  const add = (text: string, w: number) => { for (const t of tokens(text)) words.set(t, (words.get(t) || 0) + w); };

  // Compras pelos seus links: pesam mais que um pedido, porque viraram venda.
  const sales = await fetchShopeeSales(since, new Date()).catch(() => []);
  for (const s of sales) {
    if (s.status === 'CANCELLED') continue;
    items.add(s.itemId);
    add(s.itemName, 3 * Math.max(1, s.qty));
  }
  // Pedidos dos clientes no WhatsApp (tela Clientes).
  const reqs = await prisma.customerRequest.findMany({
    where: { createdAt: { gte: since }, keyword: { not: null }, customer: { userId } },
    select: { keyword: true }, take: 2000, orderBy: { createdAt: 'desc' }
  }).catch(() => []);
  for (const r of reqs) if (r.keyword) add(r.keyword, 1);

  const interest = { at: Date.now(), items, words };
  interestCache.set(userId, interest);
  return interest;
}

/** Produto já vendido pelos seus links vai na frente; depois, quem tem mais palavras do que os clientes compram/pedem. */
export async function rankBuyers(userId: string, pool: ShopeeOffer[]): Promise<ShopeeOffer[]> {
  const { items, words } = await buyerInterest(userId);
  if (!items.size && !words.size) return pool;
  const score = (o: ShopeeOffer) => (items.has(String(o.itemId)) ? 1000 : 0) + tokens(o.title).reduce((a, t) => a + (words.get(t) || 0), 0);
  return pool.map((o, i) => ({ o, i, s: score(o) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.o);
}
