import { fetchShopeeSales, type ShopeeSale } from '../integrations/shopee';
import { getSecret } from './settings';
import { prisma } from '../db';

/**
 * Relatório de vendas e comissões para o Dashboard.
 * Shopee: vem do conversionReport da Open API. Mercado Livre: não existe API de afiliado,
 * então só apontamos para o portal.
 * Cache curto em memória para não bater na Shopee a cada abertura da tela.
 */

export type Period = 'today' | '7d' | '30d' | 'month' | 'prev_month';

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; data: any }>();

function range(period: Period, tz = 'America/Sao_Paulo') {
  // Meia-noite local de hoje, em UTC, para os cortes de "hoje" e "este mês".
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = now.getTime() - local.getTime();
  const startOfLocalDay = (d: Date) => new Date(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + offsetMs);
  const startOfLocalMonth = (d: Date) => new Date(new Date(d.getFullYear(), d.getMonth(), 1).getTime() + offsetMs);
  if (period === 'today') return { start: startOfLocalDay(local), end: now };
  if (period === '7d') return { start: new Date(startOfLocalDay(local).getTime() - 6 * 86_400_000), end: now };
  if (period === 'month') return { start: startOfLocalMonth(local), end: now };
  if (period === 'prev_month') {
    const prev = new Date(local.getFullYear(), local.getMonth() - 1, 1);
    return { start: startOfLocalMonth(prev), end: new Date(startOfLocalMonth(local).getTime() - 1) };
  }
  return { start: new Date(startOfLocalDay(local).getTime() - 29 * 86_400_000), end: now };
}

function summarize(sales: ShopeeSale[]) {
  const orders = new Set(sales.map(s => s.orderId || s.conversionId));
  const by = (st: ShopeeSale['status'][]) => {
    const rows = sales.filter(s => st.includes(s.status));
    return { orders: new Set(rows.map(s => s.orderId || s.conversionId)).size, items: rows.reduce((a, s) => a + s.qty, 0), commission: round(rows.reduce((a, s) => a + s.commission, 0)) };
  };
  const total = by(['COMPLETED', 'PENDING', 'UNPAID', 'OTHER']); // cancelado não conta
  const topMap = new Map<string, { itemId: string; itemName: string; imageUrl?: string; qty: number; commission: number }>();
  for (const s of sales) {
    if (s.status === 'CANCELLED') continue;
    const cur = topMap.get(s.itemId) || { itemId: s.itemId, itemName: s.itemName, imageUrl: s.imageUrl, qty: 0, commission: 0 };
    cur.qty += s.qty; cur.commission = round(cur.commission + s.commission);
    topMap.set(s.itemId, cur);
  }
  const top = [...topMap.values()].sort((a, b) => b.commission - a.commission).slice(0, 5);
  const recent = [...sales].sort((a, b) => b.purchaseTime.getTime() - a.purchaseTime.getTime()).slice(0, 15);
  return {
    orders: orders.size,
    items: total.items,
    commission: total.commission,
    confirmed: by(['COMPLETED']),
    pending: by(['PENDING', 'UNPAID', 'OTHER']),
    cancelled: by(['CANCELLED']),
    top, recent
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function salesReport(period: Period) {
  const key = period;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.data, cached: true };

  const { start, end } = range(period);
  const shopeeConfigured = !!(await getSecret('SHOPEE_APP_ID')) && !!(await getSecret('SHOPEE_SECRET'));
  let shopee: any;
  if (!shopeeConfigured) shopee = { available: false, reason: 'Shopee não configurada em Configurações.' };
  else {
    try { const sales = await fetchShopeeSales(start, end); shopee = { available: true, ...summarize(sales), origins: await byOrigin(sales) }; }
    catch (e: any) { shopee = { available: false, reason: e.message }; }
  }
  const data = {
    period, start, end,
    shopee,
    mercadolivre: { available: false, reason: 'O Mercado Livre não disponibiliza vendas e comissões de afiliado por API.', portal: 'https://www.mercadolivre.com.br/afiliados/hub' },
    amazon: { available: false, reason: 'A Amazon não disponibiliza vendas e comissões de associado por API; veja os relatórios no portal.', portal: 'https://associados.amazon.com.br/home/reports' },
    updatedAt: new Date()
  };
  if (shopee.available) cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearSalesCache() { cache.clear(); }

/**
 * Quem gerou cada pedido: o link da Shopee sai marcado com o grupo ("g<canal>") ou o cliente
 * ("c<cliente>"). A Shopee só devolve isso para clique que virou pedido; clique sem compra não aparece.
 * Venda sem marcador (link antigo, link repassado, cópia manual) cai em "Sem identificação".
 */
async function byOrigin(sales: ShopeeSale[]) {
  type Row = { origin: string; kind: 'GROUP' | 'CUSTOMER' | 'UNKNOWN'; name: string; orders: Set<string>; items: number; commission: number; products: Map<string, { itemId: string; itemName: string; imageUrl?: string; qty: number }> };
  const rows = new Map<string, Row>();
  for (const s of sales) {
    if (s.status === 'CANCELLED') continue;
    const origin = s.origin || '';
    const kind = origin.startsWith('g') ? 'GROUP' : origin.startsWith('c') ? 'CUSTOMER' : 'UNKNOWN';
    const r = rows.get(origin) || { origin, kind, name: '', orders: new Set<string>(), items: 0, commission: 0, products: new Map() };
    r.orders.add(s.orderId || s.conversionId); r.items += s.qty; r.commission = round(r.commission + s.commission);
    const p = r.products.get(s.itemId) || { itemId: s.itemId, itemName: s.itemName, imageUrl: s.imageUrl, qty: 0 };
    p.qty += s.qty; r.products.set(s.itemId, p);
    rows.set(origin, r);
  }
  const ids = (k: string) => [...rows.values()].filter(r => r.kind === k).map(r => r.origin.slice(1));
  const [channels, customers] = await Promise.all([
    prisma.channel.findMany({ where: { id: { in: ids('GROUP') } }, select: { id: true, name: true } }),
    prisma.customer.findMany({ where: { id: { in: ids('CUSTOMER') } }, select: { id: true, givenName: true, name: true, phone: true } })
  ]);
  const chName = new Map(channels.map(c => [c.id, c.name]));
  const cuName = new Map(customers.map(c => [c.id, c.givenName || c.name || c.phone || 'Cliente']));
  return [...rows.values()].map(r => ({
    origin: r.origin, kind: r.kind,
    name: r.kind === 'GROUP' ? chName.get(r.origin.slice(1)) || 'Grupo removido'
      : r.kind === 'CUSTOMER' ? cuName.get(r.origin.slice(1)) || 'Cliente removido'
      : 'Sem identificação',
    orders: r.orders.size, items: r.items, commission: r.commission,
    products: [...r.products.values()].sort((a, b) => b.qty - a.qty)
  })).sort((a, b) => (a.kind === 'UNKNOWN' ? 1 : 0) - (b.kind === 'UNKNOWN' ? 1 : 0) || b.orders - a.orders || b.commission - a.commission);
}
