/**
 * Importação de um produto do Mercado Livre pela URL.
 * O ML aceita dois formatos de link:
 *   - anúncio:  produto.mercadolivre.com.br/MLB-5074854807-...   (id com hífen)
 *   - catálogo: www.mercadolivre.com.br/p/MLB26034306             (id sem hífen)
 * Desde 2025 o endpoint /items/{id} devolve 403 para apps de afiliado, então o anúncio só
 * funciona se o ML liberar; o catálogo funciona sempre (/products/{id} + /products/{id}/items).
 */
export function extractMercadoLivreItemId(input: string) {
  const match = input.match(/MLB-?(\d{6,})/i);
  return match?.[1] ? `MLB${match[1]}` : null;
}

type ImportedItem = {
  externalId: string; title: string; productUrl: string; imageUrl?: string;
  price?: number; oldPrice?: number; discountPercent?: number; description?: string;
};

const headers = (token?: string) => ({ accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const discount = (price?: number, oldPrice?: number) => oldPrice && price && oldPrice > price ? Math.round((1 - price / oldPrice) * 100) : undefined;

async function fetchItem(itemId: string, token?: string): Promise<ImportedItem | null> {
  const r = await fetch(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, { headers: headers(token) });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Mercado Livre respondeu ${r.status}.`);
  const data: any = await r.json();
  const price = Number(data.price || 0) || undefined;
  const oldPrice = Number(data.original_price || 0) || undefined;
  return { externalId: data.id, title: data.title, productUrl: data.permalink, imageUrl: data.thumbnail?.replace(/^http:/, 'https:'), price, oldPrice, discountPercent: discount(price, oldPrice), description: data.subtitle || undefined };
}

async function fetchCatalogProduct(productId: string, token?: string): Promise<ImportedItem | null> {
  const r = await fetch(`https://api.mercadolibre.com/products/${encodeURIComponent(productId)}`, { headers: headers(token) });
  if (r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Mercado Livre respondeu ${r.status}.`);
  const data: any = await r.json();
  if (!data?.id) return null;
  let price: number | undefined; let oldPrice: number | undefined;
  const items = await fetch(`https://api.mercadolibre.com/products/${encodeURIComponent(productId)}/items?limit=50`, { headers: headers(token) });
  if (items.ok) {
    for (const it of ((await items.json()) as any)?.results || []) {
      const p = Number(it?.price); if (!p || (it.condition && it.condition !== 'new')) continue;
      if (!price || p < price) { price = p; const o = Number(it.original_price) || undefined; oldPrice = o && o > p ? o : undefined; }
    }
  }
  const pic: string | undefined = data.pictures?.[0]?.url;
  return { externalId: data.id, title: String(data.name || 'Produto Mercado Livre').slice(0, 200), productUrl: `https://www.mercadolivre.com.br/p/${data.id}`, imageUrl: pic?.replace(/^http:/, 'https:'), price, oldPrice, discountPercent: discount(price, oldPrice), description: data.short_description?.content || undefined };
}

export async function fetchMercadoLivreItem(itemId: string, accessToken?: string): Promise<ImportedItem> {
  // O id sozinho não diz se é anúncio ou produto de catálogo: tenta os dois em paralelo.
  const [asItem, asProduct] = await Promise.all([fetchItem(itemId, accessToken).catch(() => null), fetchCatalogProduct(itemId, accessToken).catch(() => null)]);
  const found = asItem || asProduct;
  if (found) return found;
  throw new Error('O Mercado Livre não libera os dados desse anúncio para o aplicativo (403). Use o link da página de catálogo (mercadolivre.com.br/p/MLB...) ou cadastre o produto manualmente.');
}
