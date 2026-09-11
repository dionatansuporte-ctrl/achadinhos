import type { ReactNode } from 'react';
import { createElement, Fragment } from 'react';

/**
 * Prévia do template no navegador. Espelha o renderOffer da API com um produto
 * de exemplo, para o usuário ver a mensagem antes de salvar a automação.
 */
const SAMPLE = { title: 'Fone Bluetooth JBL Tune 510BT', price: 89.9, oldPrice: 199.9, discountPercent: 55, couponText: 'FONE10', affiliateUrl: 'https://s.shopee.com.br/8AVpXJSkl6' };
const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Mesmo modelo padrão da API (services/offer.ts). Negrito no WhatsApp é UM asterisco. */
export const DEFAULT_TEMPLATE = [
  '🔥 *OFERTA DO DIA!*',
  '',
  '🛍️ *{{title}}*',
  '',
  '💰 *DE* ~{{oldPrice}}~',
  '🔥 *POR APENAS {{price}}*',
  '',
  '🏷️ *{{discountPercent}} DE DESCONTO*',
  '🎟️ *Cupom: {{coupon}}*',
  '',
  '⚡ *Aproveite enquanto durar o estoque!*',
  '',
  '🛒 *COMPRAR AGORA:*',
  '{{affiliateUrl}}',
  '',
  '⚠️ As promoções são por tempo limitado e podem mudar a qualquer momento.'
].join('\n');

export function renderOfferText(template: string, p = SAMPLE): string {
  const fromTo = p.oldPrice > p.price ? `De ~${brl(p.oldPrice)}~ por *${brl(p.price)}*` : `Por *${brl(p.price)}*`;
  const vars: Record<string, string> = {
    title: p.title, price: brl(p.price), oldPrice: brl(p.oldPrice), fromTo, dePor: fromTo,
    discount: `${p.discountPercent}% OFF`, discountPercent: `${p.discountPercent}%`, coupon: p.couponText, affiliateUrl: p.affiliateUrl
  };
  const RE = /\{\{\s*(\w+)\s*\}\}/g;
  return template
    .replace(/\\n/g, '\n')
    .split('\n')
    .filter(line => { for (const m of line.matchAll(RE)) { if (!(vars[m[1]] || '').trim()) return false; } return true; })
    .map(line => line.replace(RE, (_, k) => vars[k] ?? ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texto com *negrito* e ~riscado~ renderizados como no WhatsApp. */
export function previewOffer(template: string): ReactNode {
  const parts = renderOfferText(template).split(/(\*[^*\n]+\*|~[^~\n]+~)/g);
  return createElement(Fragment, null, ...parts.map((s, i) =>
    /^\*[^*]+\*$/.test(s) ? createElement('b', { key: i }, s.slice(1, -1))
      : /^~[^~]+~$/.test(s) ? createElement('s', { key: i }, s.slice(1, -1))
        : s
  ));
}

/** O template mostra o preço antigo? (linha "DE R$ X" ou "De X por Y") */
export const hasOldPrice = (template: string) => template.includes('{{oldPrice}}') || template.includes('{{fromTo}}');

/** Liga/desliga a linha do preço antigo. Espelha toggleOldPrice da API. */
export function toggleFromTo(template: string, on: boolean): string {
  if (on) {
    if (hasOldPrice(template)) return template;
    if (/^.*\{\{price\}\}.*$/m.test(template)) return template.replace(/^(.*\{\{price\}\}.*)$/m, '💰 *DE* ~{{oldPrice}}~\n$1');
    return template.replace('{{title}}', '{{title}}\n\n💰 *DE* ~{{oldPrice}}~');
  }
  return template
    .split('\n').filter(l => !l.includes('{{oldPrice}}')).join('\n')
    .replace(/^.*\{\{fromTo\}\}.*$/m, '🔥 *POR APENAS {{price}}*');
}
