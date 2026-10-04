import type { ShopeeOffer } from '../integrations/shopee';

/**
 * Filtro de relevância das automações: a busca das lojas é frouxa e, numa automação de
 * Eletrônicos, trazia triciclo, saquinho plástico, isca de barata e celular de brinquedo
 * (pedido do usuário em 2026-10-04: "seja apurado nas categorias solicitadas").
 * Duas regras, por termo da busca:
 *  1. Item de criança/bebê/brinquedo só passa se o termo pede isso ("Drones de Brinquedo")
 *     ou se a automação inteira é infantil (muitos termos de criança).
 *  2. O título precisa ter a palavra principal do termo ("moto eletrica" -> "moto"), aceitando
 *     plural, sinônimos e alternativas ("Facas e Canivetes" aceita faca OU canivete). Nome de
 *     categoria ("Moda Feminina", "Cozinha") quase nunca aparece no título: essas palavras não
 *     contam, e quando a regra derrubaria metade ou mais do resultado ela é ignorada para o termo.
 */

const fold = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

const KID_RE = /\b(brinquedos?|infantil|infantis|bebes?|crianca|criancas|kids?|menin[oa]s?|educativ[oa]s?|maternidade|fraldas?|flaudas?|huggies|pampers)\b/;
const isKid = (s: string) => KID_RE.test(fold(s));

const STOP = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'ou', 'com', 'para', 'pra', 'em', 'no', 'na', 'o', 'a', 'os', 'as', 'kit', 'kits', 'novo', 'nova', 'outros', 'acessorios', 'acessorio']);

// A palavra principal do termo e outras formas como ela aparece nos anúncios.
const SYNONYMS: Record<string, string[]> = {
  celular: ['smartphone', 'iphone', 'galaxy', 'redmi', 'xiaomi', 'motorola', 'poco', 'telefone'],
  telefone: ['celular', 'smartphone'],
  tv: ['televis', 'smart tv', 'smarttv'],
  televisor: ['tv', 'televis'],
  video: ['videogame', 'console', 'game'],
  game: ['console', 'videogame', 'jogo', 'controle', 'joystick', 'gamer'],
  camera: ['cam', 'webcam', 'filmadora'],
  relogio: ['smartwatch', 'watch'],
  fone: ['headphone', 'headset', 'earbud', 'tws', 'airpods', 'ouvido'],
  computador: ['pc', 'desktop', 'cpu'],
  notebook: ['laptop', 'chromebook', 'macbook'],
  eletronico: ['eletron'],
  impressora: ['impress'],
  monitor: ['tela', 'display'],
};

/** "celulares" -> "celular", "monitores" -> "monitor", "drones" -> "drone", "robos" -> "robo". */
function stem(w: string) {
  if (w.length > 5 && /(ores|ares)$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && /oes$/.test(w)) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Nomes de seção da loja: o anúncio de um batom não diz "beleza", o de um liquidificador não diz "cozinha".
const GENERIC = new Set(['moda', 'cozinha', 'beleza', 'casa', 'decoracao', 'fitness', 'esporte', 'pet', 'saude', 'variedade', 'utilidade', 'papelaria', 'informatica', 'automotivo', 'veiculo', 'eletrodomestico', 'hobby', 'hobbie', 'lazer', 'presente']);

/**
 * Palavras principais do termo: a primeira que não é enfeite em cada alternativa
 * ("Celulares e Acessórios" -> [celular]; "Facas e Canivetes" -> [faca, canivete]).
 */
function headWords(term: string) {
  const out = new Set<string>();
  for (const part of fold(term).split(/,|\s+e\s+|\s*\/\s*/)) {
    const w = words(part).map(stem).find(w => w.length >= 2 && !STOP.has(w) && !GENERIC.has(w) && !/^\d+$/.test(w));
    if (w) out.add(w);
  }
  return [...out];
}

function titleHas(title: string, head: string) {
  const t = fold(title);
  // Prefixo da palavra (aceita "eletronica" para "eletronico", "drone" para "drones").
  const root = head.length > 6 ? head.slice(0, head.length - 1) : head;
  const forms = [root, ...(SYNONYMS[head] || [])];
  return forms.some(f => new RegExp(`(^|[^a-z0-9])${f.replace(/ /g, '[\\s-]*')}`).test(t));
}

/** A automação é infantil? (muitos termos de criança: aí brinquedo/bebê é o assunto, não lixo). */
export function kidThemed(terms: string[]) {
  return terms.length > 0 && terms.filter(isKid).length / terms.length >= 0.25;
}

/** Aplica as duas regras a um termo. `kidOk` = automação infantil. */
export function filterByTerm(term: string | undefined, offers: ShopeeOffer[], kidOk: boolean): ShopeeOffer[] {
  if (!term || !offers.length) return offers;
  const kidAllowed = kidOk || isKid(term);
  const base = kidAllowed ? offers : offers.filter(o => !isKid(o.title));
  const heads = headWords(term);
  if (!heads.length) return base;
  const matched = base.filter(o => heads.some(h => titleHas(o.title, h)));
  // Termo que a loja entende como categoria ("Brinquedos para Bebês"): o nome não costuma estar
  // no título. Se a regra derrubaria metade ou mais, é esse o caso: não filtra por palavra.
  return matched.length * 2 >= base.length ? matched : base;
}
