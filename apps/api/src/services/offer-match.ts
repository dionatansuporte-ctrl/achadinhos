import type { ShopeeOffer } from '../integrations/shopee';

/**
 * Confere se o título de uma oferta bate com o que o cliente pediu.
 *
 * As buscas dos marketplaces são frouxas: a Shopee devolve "suporte para TV" ao buscar "tv 50
 * polegadas" e o Mercado Livre nem busca por palavra (pega os mais vendidos da categoria, então
 * vem TV 32). Pedido do usuário em 2026-09-25: "tv 50 polegadas" tem que trazer TV de 50, não
 * suporte nem TV de 32. Regras:
 *   - todo número do pedido (50, 128gb, 4k) precisa estar no título, como número inteiro
 *     ("1500" não vale por "50");
 *   - toda palavra do pedido precisa estar no título (marca, modelo, tipo), aceitando sinônimos
 *     ("tv" casa com "televisão"/"televisor") e plural ("tv" casa com "tvs");
 *   - unidade ("polegadas", "litros") é opcional: o anúncio escreve 50" ou 50 pol;
 *   - acessório do produto pedido é descartado: "suporte para tv", "capa celular", "controle
 *     remoto", "tv box"... a menos que o cliente tenha pedido o acessório.
 * Sem resultado estrito, o modo relaxado exige só os números e o produto em si.
 */

const fold = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Palavras que enfeitam o pedido e não precisam estar no anúncio.
const STOP = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'ou', 'com', 'para', 'pra', 'em', 'no', 'na', 'o', 'a', 'os', 'as', 'um', 'uma', 'novo', 'nova', 'original', 'barato', 'barata', 'bom', 'boa', 'top', 'promocao', 'oferta']);
// Unidades: o número é obrigatório, a unidade não (anúncio escreve 50", 50 pol, 50 polegadas).
const UNITS = new Set(['polegada', 'polegadas', 'pol', 'litro', 'litros', 'l', 'lt', 'lts', 'kg', 'g', 'gr', 'gb', 'tb', 'mb', 'w', 'watts', 'watt', 'btu', 'btus', 'cm', 'mm', 'm', 'ml', 'lugar', 'lugares', 'boca', 'bocas', 'peca', 'pecas', 'unidade', 'unidades', 'un', 'hz', 'mah', 'mp', 'v', 'volts', 'marcha', 'marchas', 'ano', 'anos', 'mes', 'meses', 'pcs', 'metro', 'metros']);
// Unidade que faz parte do nome do modelo: "4k", "128gb" precisam aparecer colados ou com espaço.
const LITERAL_UNITS = new Set(['k', 'gb', 'tb', 'mp', 'mah', 'hz']);

// Sinônimos: pedido "tv" aceita anúncio "Televisão"; pedido "fone" aceita "Headphone".
const SYNONYMS: string[][] = [
  ['tv', 'televisao', 'televisor', 'smart tv'],
  ['celular', 'smartphone', 'telefone celular'],
  ['notebook', 'laptop'],
  ['fone', 'headphone', 'headset', 'earbud', 'earbuds', 'earphone', 'airpods'],
  ['relogio', 'smartwatch', 'smart watch'],
  ['geladeira', 'refrigerador'],
  ['fogao', 'cooktop'],
  ['lavadora', 'maquina de lavar', 'lava e seca'],
  ['ar condicionado', 'split', 'ar-condicionado'],
  ['micro ondas', 'microondas', 'micro-ondas'],
  ['air fryer', 'airfryer', 'fritadeira'],
  ['tenis', 'sneaker'],
  ['caixa de som', 'caixinha de som', 'speaker'],
  ['videogame', 'console', 'video game'],
  ['bicicleta', 'bike'],
  ['camera', 'webcam'],
  ['mochila', 'bolsa'],
  ['sofa', 'sofa retratil'],
  ['carregador', 'fonte'],
  ['capinha', 'capa', 'case'],
  ['pelicula', 'pelicula de vidro'],
  ['colchao', 'colchoes'],
  ['oculos', 'oculos de sol']
];

// Acessórios: aparecem no título junto do produto pedido e enganam a busca.
const ACCESSORY_WORDS = ['suporte', 'capa', 'capinha', 'case', 'pelicula', 'controle remoto', 'controle', 'cabo', 'adaptador', 'carregador', 'fonte', 'bateria', 'protetor', 'antena', 'conversor', 'fita', 'adesivo', 'limpador', 'refil', 'reposicao', 'tv box', 'rack', 'painel', 'prateleira', 'bracadeira', 'pelicula', 'pilha', 'lampada', 'placa', 'modulo', 'kit reparo', 'sensor', 'motor', 'resistencia', 'helice', 'engrenagem', 'tampa', 'jarra', 'filtro', 'reservatorio', 'copo', 'peca de reposicao', 'pecas de reposicao', 'acessorio', 'acessorios'];

export type RequestTerms = {
  numbers: string[];   // "50", "128": precisam aparecer no título como número inteiro
  literals: string[];  // "4k", "128gb": precisam aparecer (com ou sem espaço)
  words: string[][];   // cada item = palavra pedida e seus sinônimos; uma delas precisa aparecer
  product: string[];   // primeira palavra do pedido (o produto em si) e sinônimos
  accessories: string[]; // palavras de acessório que o próprio cliente pediu (não descartar)
};

const synonymsOf = (w: string) => SYNONYMS.find(g => g.includes(w)) || [w];

/** Quebra o pedido do cliente nas partes que o anúncio precisa ter. */
export function requestTerms(keyword: string): RequestTerms {
  const k = fold(keyword).replace(/[^a-z0-9\/"'+.\s-]/g, ' ').replace(/(\d)\s*(?:"|''|polegadas?|pol)\b/g, '$1 polegadas');
  const tokens = k.split(/[\s\-\/]+/).filter(Boolean);
  const t: RequestTerms = { numbers: [], literals: [], words: [], product: [], accessories: [] };
  for (const tok of tokens) {
    const m = /^(\d+)([a-z]+)$/.exec(tok);
    if (/^\d+$/.test(tok)) { t.numbers.push(tok); continue; }
    if (m) { if (LITERAL_UNITS.has(m[2])) t.literals.push(tok); else t.numbers.push(m[1]); continue; }
    const w = tok.replace(/[^a-z0-9]/g, '');
    if (!w || w.length < 2 || STOP.has(w) || UNITS.has(w)) continue;
    const syn = synonymsOf(w);
    t.words.push(syn);
    if (!t.product.length) t.product = syn;
    if (ACCESSORY_WORDS.some(a => a === w || a.split(' ')[0] === w)) t.accessories.push(w);
  }
  // Nome composto ("ar condicionado", "air fryer", "caixa de som"): junta pra casar como um só.
  const joined = tokens.filter(x => !/^\d/.test(x)).join(' ');
  for (const g of SYNONYMS) for (const s of g) if (s.includes(' ') && joined.includes(s)) {
    const parts = s.split(' ');
    t.words = t.words.filter(ws => !parts.includes(ws[0]));
    t.words.unshift(g);
    t.product = g;
  }
  return t;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (title: string, w: string) => new RegExp(`(^|[^a-z])${esc(w).replace(/ /g, '[\\s-]*')}`).test(title);
const hasNumber = (title: string, n: string) => new RegExp(`(^|[^0-9.,])${n}([^0-9]|$)`).test(title);
const hasLiteral = (title: string, l: string) => { const m = /^(\d+)([a-z]+)$/.exec(l)!; return new RegExp(`(^|[^0-9.,])${m[1]}\\s*${m[2]}`).test(title); };

/** O anúncio é um acessório do produto pedido ("suporte para tv", "capa celular", "tv box")? */
function isAccessory(title: string, t: RequestTerms) {
  for (const a of ACCESSORY_WORDS) {
    if (t.accessories.includes(a.split(' ')[0])) continue;
    if (!hasWord(title, a)) continue;
    // "controle" só é acessório quando o produto pedido não é um controle; idem para os outros.
    if (t.product.some(p => a === p || a.split(' ')[0] === p)) continue;
    return true;
  }
  // "X para tv", "X p/ celular": qualquer coisa "para" o produto pedido é acessório dele.
  const prod = t.product.map(p => esc(p).replace(/ /g, '[\\s-]*')).join('|');
  if (prod && new RegExp(`\\b(para|pra|p\\/|p)\\s*(a|o|as|os|sua|seu|todas|todos)?\\s*(${prod})`).test(title)) return true;
  return false;
}

export type MatchLevel = 'strict' | 'relaxed';
/** O título bate com o pedido? strict = tudo; relaxed = só números, modelo e o produto em si. */
export function offerMatches(title: string, t: RequestTerms, level: MatchLevel = 'strict') {
  const s = fold(title);
  if (!t.numbers.every(n => hasNumber(s, n))) return false;
  if (!t.literals.every(l => hasLiteral(s, l))) return false;
  if (isAccessory(s, t)) return false;
  if (t.product.length && !t.product.some(p => hasWord(s, p))) return false;
  if (level === 'strict' && !t.words.every(ws => ws.some(w => hasWord(s, w)))) return false;
  return true;
}

/**
 * Filtra as ofertas pelo pedido: primeiro tudo batendo; sem nenhuma, o modo relaxado. Mantém a
 * ordem original (mais vendidos). Devolve também qual modo foi usado, para o texto ao cliente.
 */
export function filterByRequest(offers: ShopeeOffer[], keyword: string): { offers: ShopeeOffer[]; level: MatchLevel | 'none' } {
  const t = requestTerms(keyword);
  const strict = offers.filter(o => offerMatches(o.title, t, 'strict'));
  if (strict.length) return { offers: strict, level: 'strict' };
  const relaxed = offers.filter(o => offerMatches(o.title, t, 'relaxed'));
  return relaxed.length ? { offers: relaxed, level: 'relaxed' } : { offers: [], level: 'none' };
}
