type ProductOffer = {
  title: string;
  price?: number;
  oldPrice?: number;
  discountPercent?: number;
  couponText?: string;
  affiliateUrl: string;
};

// Padrão brasileiro: "R$ 1.299,90".
const brl = (n: number) => `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Preenche o template com os dados do produto.
 * Variáveis: {{title}} {{price}} {{oldPrice}} {{fromTo}} {{discount}} {{coupon}} {{affiliateUrl}}
 * Formatação do WhatsApp: *negrito*, ~riscado~, _itálico_.
 * Linha cuja variável ficou vazia (sem cupom, sem desconto...) é removida inteira,
 * para não sobrar "🎟️ Cupom: **".
 */
export function renderOffer(template: string, product: ProductOffer) {
  const discount = product.discountPercent != null && product.discountPercent > 0
    ? `${product.discountPercent}% OFF`
    : product.oldPrice && product.price && product.oldPrice > product.price
      ? `${Math.round((1 - product.price / product.oldPrice) * 100)}% OFF`
      : "";

  // "De R$ 199,90 por R$ 89,90" com o preço antigo riscado; sem preço antigo, só "Por R$ 89,90".
  const fromTo = product.price != null
    ? product.oldPrice && product.oldPrice > product.price
      ? `De ~${brl(product.oldPrice)}~ por *${brl(product.price)}*`
      : `Por *${brl(product.price)}*`
    : "";

  const vars: Record<string, string> = {
    title: product.title,
    price: product.price != null ? brl(product.price) : "",
    oldPrice: product.oldPrice != null ? brl(product.oldPrice) : "",
    fromTo,
    dePor: fromTo,
    discount,
    // Só o número, para frases como "{{discountPercent}} DE DESCONTO".
    discountPercent: discount ? discount.replace(/\s*OFF$/i, '') : "",
    coupon: product.couponText || "",
    affiliateUrl: product.affiliateUrl
  };

  return fillTemplate(template, vars);
}

export function fillTemplate(template: string, vars: Record<string, string>) {
  const RE = /\{\{\s*(\w+)\s*\}\}/g;
  return template
    // Templates antigos ou colados de fora podem trazer "\n" literal.
    .replace(/\\n/g, "\n")
    .split("\n")
    .filter(line => {
      // Some a linha quando alguma variável dela não tem valor.
      for (const m of line.matchAll(RE)) { if (!(vars[m[1]] || "").trim()) return false; }
      return true;
    })
    .map(line => line.replace(RE, (_, k) => vars[k] ?? ""))
    // Linha que virou só enfeite ("🏷️ ") ou só rótulo ("De: ").
    .filter(line => line.trim() === "" || !/^\s*[^\p{L}\p{N}]*\s*$/u.test(line))
    .filter(line => !/^[^\p{L}\p{N}]*\s*[\p{L} ]{1,12}:\s*$/u.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Modelo padrão (formato pedido pelo usuário). Negrito no WhatsApp é UM asterisco.
 * Linhas com variável vazia somem sozinhas: sem preço antigo, a linha "DE" não aparece;
 * sem cupom, a linha do cupom não aparece.
 */
export function defaultOfferTemplate() {
  return [
    "🔥 *OFERTA DO DIA!*",
    "",
    "🛍️ *{{title}}*",
    "",
    "💰 *DE* ~{{oldPrice}}~",
    "🔥 *POR APENAS {{price}}*",
    "",
    "🏷️ *{{discountPercent}} DE DESCONTO*",
    "🎟️ *Cupom: {{coupon}}*",
    "",
    "⚡ *Aproveite enquanto durar o estoque!*",
    "",
    "🛒 *COMPRAR AGORA:*",
    "{{affiliateUrl}}",
    "",
    "⚠️ As promoções são por tempo limitado e podem mudar a qualquer momento."
  ].join("\n");
}

/** Liga/desliga a linha do preço antigo ("DE R$ X") num template qualquer. */
export function toggleOldPrice(template: string, on: boolean) {
  const hasOld = template.includes("{{oldPrice}}") || template.includes("{{fromTo}}");
  if (on) {
    if (hasOld) return template;
    if (/^.*\{\{price\}\}.*$/m.test(template)) return template.replace(/^(.*\{\{price\}\}.*)$/m, "💰 *DE* ~{{oldPrice}}~\n$1");
    return template.replace("{{title}}", "{{title}}\n\n💰 *DE* ~{{oldPrice}}~");
  }
  return template
    .split("\n").filter(l => !l.includes("{{oldPrice}}")).join("\n")
    .replace(/^.*\{\{fromTo\}\}.*$/m, "🔥 *POR APENAS {{price}}*");
}
