export type ShopeeRow = {
  productUrl?: string;
  affiliateUrl?: string;
  title?: string;
  price?: string;
};

const RE_URL = /https?:\/\/[^\s,"']+/g;
// Colunas separadas por vírgula, respeitando trechos entre aspas ("5,69" é uma célula só).
const RE_CELL = /"[^"]*"|[^,]+/g;
const RE_IS_URL = /^https?:\/\//i;
const RE_SHORT_LINK = /(s\.shopee\.|shope\.ee|\/affiliate)/i;
const RE_SHOPEE = /shopee\./i;
const RE_PERCENT = /%\s*$/;
const RE_SALES = /(mil|mi|k)\+?\s*$/i;
const RE_ONLY_DIGITS = /^\d+$/;
const RE_MONEY = /^R?\$?\s*\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d+)?$/;

/**
 * Lê uma linha exportada do painel de afiliado da Shopee.
 * A ordem das colunas varia conforme o relatório, então cada campo é identificado
 * pelo formato e não pela posição.
 */
export function parseShopeeRow(raw: string): ShopeeRow {
  const out: ShopeeRow = {};
  const text = raw.replace(/[\r\n]+/g, ' ').trim();
  if (!text) return out;

  const urls = text.match(RE_URL) || [];
  for (const u of urls) {
    const clean = u.replace(/[,;]+$/, '');
    if (RE_SHORT_LINK.test(clean)) out.affiliateUrl = clean;
    else if (RE_SHOPEE.test(clean)) out.productUrl = clean;
  }
  // Sem link curto reconhecível: assume a ordem produto, afiliado.
  if (!out.productUrl && urls.length) out.productUrl = String(urls[0]).replace(/[,;]+$/, '');
  if (!out.affiliateUrl && urls.length > 1) out.affiliateUrl = String(urls[1]).replace(/[,;]+$/, '');

  const cells = (text.match(RE_CELL) || [])
    .map(c => c.trim().replace(/^"|"$/g, '').trim())
    .filter(Boolean);

  // Título: a maior célula de texto que não seja link, número, percentual ou volume de vendas.
  const titles = cells.filter(c =>
    !RE_IS_URL.test(c) &&
    !RE_ONLY_DIGITS.test(c) &&
    !RE_PERCENT.test(c) &&
    !RE_SALES.test(c) &&
    !RE_MONEY.test(c) &&
    c.length > 8
  );
  if (titles.length) out.title = titles.sort((a, b) => b.length - a.length)[0];

  // Preço: primeira célula monetária. Percentual é comissão, não preço.
  const money = cells.filter(c =>
    !RE_IS_URL.test(c) &&
    !RE_PERCENT.test(c) &&
    !RE_SALES.test(c) &&
    RE_MONEY.test(c) &&
    /[.,]/.test(c)
  );
  if (money.length) out.price = money[0].replace(/[R$\s]/g, '');

  return out;
}
