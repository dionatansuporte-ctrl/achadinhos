/**
 * Chave de comparação de títulos de produto.
 *
 * O mesmo produto aparece na Shopee e no Mercado Livre em vários anúncios (vendedores
 * diferentes), cada um com seu ID e URL, mas o título é igual ou quase igual. Para o robô
 * não mandar "o mesmo produto" duas vezes no dia, comparamos os títulos normalizados:
 * minúsculas, sem acento, sem pontuação, só palavras com 3+ letras, em ordem alfabética.
 */

const STOP = new Set(['com', 'para', 'por', 'sem', 'the', 'and', 'kit', 'original', 'promocao', 'oferta', 'envio', 'frete', 'gratis', 'novo', 'nova', 'unidade', 'unidades', 'pcs', 'pecas', 'peca']);

export function titleWords(title: string | null | undefined): string[] {
  const words = String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}+/gu, '') // remove acentos
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length >= 3 && !STOP.has(w));
  return Array.from(new Set(words)).sort();
}

/** Chave exata: títulos com as mesmas palavras dão a mesma chave. Vazio se o título não tem palavra útil. */
export function titleKey(title: string | null | undefined): string {
  return titleWords(title).join(' ');
}

/** Índice de Jaccard entre dois conjuntos de palavras (0 = nada em comum, 1 = iguais). */
export function titleSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const w of a) if (sb.has(w)) inter++;
  return inter / (a.length + b.length - inter);
}

/**
 * A partir disso, dois títulos são o mesmo modelo (mesmo produto em outro anúncio ou variação).
 * Era 0,8, mas "Armário Star 3 Nichos ... Preto" x "... Cedro" dá 0,75 e "Pulseira Gcm Silicone
 * Magnético Deployant Mostarda" x "... Fecho Magnético Silicone Branco" dá 0,60: mesmo modelo, outra cor.
 * Modelos parecidos mas diferentes (8bitdo Ultimate 2C x Ultimate C) ficam em 0,45.
 */
export const TITLE_SIMILAR_MIN = 0.6;

/** Primeira palavra útil do título na ordem original: em anúncio brasileiro costuma ser o produto ("Filamento", "Controle", "Mochila"). */
export function titleHead(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .find(w => w.length >= 3 && !STOP.has(w)) || '';
}

/**
 * Parte das palavras do título menor que também está no outro (0 = nada em comum, 1 = um contém o outro).
 * Mais solto que o Jaccard: serve para dizer se dois produtos são "do mesmo tipo" (dois filamentos,
 * duas centrais multimídia), não se são o mesmo modelo.
 */
export function titleOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const w of a) if (sb.has(w)) inter++;
  return inter / Math.min(a.length, b.length);
}

/** A partir disso, dois títulos são o mesmo tipo de produto (a automação evita mandá-los em sequência). */
export const KIND_SIMILAR_MIN = 0.4;
