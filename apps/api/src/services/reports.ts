import { fetchShopeeSales, type ShopeeSale } from '../integrations/shopee';
import { getSecret } from './settings';

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
    try { shopee = { available: true, ...summarize(await fetchShopeeSales(start, end)) }; }
    catch (e: any) { shopee = { available: false, reason: e.message }; }
  }
  const data = {
    period, start, end,
    shopee,
    mercadolivre: { available: false, reason: 'O Mercado Livre não disponibiliza vendas e comissões de afiliado por API.', portal: 'https://www.mercadolivre.com.br/afiliados/hub' },
    updatedAt: new Date()
  };
  if (shopee.available) cache.set(key, { at: Date.now(), data });
  return data;
}

export function clearSalesCache() { cache.clear(); }
