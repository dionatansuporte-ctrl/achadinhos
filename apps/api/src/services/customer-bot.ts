import type { Customer, CustomerBot, Marketplace } from '@prisma/client';
import { prisma } from '../db';
import { onWhatsAppMessage, sendWhatsAppWebText, showTyping, getWaState, anyWaConnected, type WaIncoming } from '../integrations/whatsapp-web';
import { shopeeTrackedLink, type ShopeeOffer } from '../integrations/shopee';
import { searchOffers } from './shopee-sync';
import { isMarketplace, marketplaceIcon, marketplaceLabel, storeIn, storeOf, type SearchMarketplace } from './marketplaces';
import { renderOffer, defaultOfferTemplate } from './offer';
import { titleKey } from './title-key';
import { filterByRequest, type MatchLevel } from './offer-match';
import { productCoupons, pickCoupon, usableCoupons, couponListMessage, getSchedule, MARKETPLACES } from './coupons';
import { importTelegramCoupons } from './coupon-import';

/**
 * Atendimento a clientes no privado do WhatsApp.
 *
 * O cliente entra pelo link wa.me do número pareado e escreve o que procura
 * ("quero oferta de fone bluetooth"). O robô busca na Shopee/Mercado Livre e responde
 * só para ele, com o link de afiliado. Regras pedidas pelo usuário:
 *   - limite por tempo: cada cliente é atendido no máximo uma vez a cada `everyMinutes`
 *     (evita enxurrada de mensagens e o WhatsApp marcar o número como spam). Pedido dentro do
 *     limite fica guardado (CustomerRequest LIMITED com keyword + loja) e sai SOZINHO quando o
 *     limite passa, sem o cliente pedir de novo (pedido do usuário em 2026-09-26, ver
 *     deliverPendingSearches);
 *   - pediu cupom? manda o listão de cupons válidos do Mercado Livre e da Shopee com o link do
 *     usuário (o mesmo da tela Cupons). Só cupom não passa pelo limite por tempo: é barato e quem
 *     pergunta "cupom" quer resposta na hora, não "volte em 8 min";
 *   - "chega de oferta" desliga o cliente (optedOut) e "quero oferta" liga de novo;
 *   - loja: sem a loja no pedido ("fone na shopee"), o robô pergunta "Shopee, Mercado Livre ou
 *     qualquer uma?" antes de buscar (CustomerBot.askMarketplace, pedido do usuário em 2026-09-26);
 *     "qualquer uma"/"tanto faz" busca nas duas e intercala. A pergunta vale 30 min (status ASK_STORE)
 *     e não gasta o limite por tempo;
 *   - pedido genérico ("tv", "celular", "notebook"...) ganha antes uma pergunta de detalhes
 *     (tamanho, marca, modelo) e a resposta do cliente vira a busca ("tv 50 samsung 4k"):
 *     oferta mais certeira = compra mais fácil (pedido do usuário em 2026-09-25);
 *   - na primeira conversa o robô pergunta o nome ("como posso te chamar?") e usa a resposta nas
 *     mensagens seguintes (pedido do usuário em 2026-09-25); pergunta uma vez só, e quem responde
 *     com um pedido em vez do nome é atendido normalmente com o nome do perfil do WhatsApp.
 *     No primeiro contato vai só a apresentação + "como posso te chamar?"; o texto de boas-vindas
 *     (que manda digitar o produto) só depois do nome, pra não confundir (2026-09-26);
 *   - NENHUMA mensagem fica sem resposta: saudação repetida, mensagem dentro do limite, cliente
 *     que pediu "chega", áudio/foto/figurinha e até erro interno recebem pelo menos uma linha.
 *     Só bloqueado (botão da tela) é ignorado de propósito.
 * Tudo que chega vira uma linha em CustomerRequest, que a tela Clientes mostra.
 */

/** Boas-vindas padrão; cita só as lojas que o robô usa. */
const defaultWelcome = (stores: SearchMarketplace[]) => [
  'Olá! 👋 Sou o robô de ofertas.',
  '',
  'Me diga o que você procura e eu te mando as melhores ofertas. Exemplos:',
  '• _fone bluetooth_',
  '• _air fryer_',
  '• _tênis masculino_',
  '',
  'Quanto mais detalhes (marca, tamanho, modelo), mais certeira a oferta. 😉',
  ...(stores.length > 1 ? [`Prefere ${storeList(stores)}? Pode dizer junto (_fone bluetooth ${storeIn(stores[0])}_).`] : []),
  '',
  `Quer cupons? Escreva *cupom*${stores.length > 1 ? ` (ou ${stores.map(s => `*cupom ${marketplaceLabel(s).toLowerCase()}*`).join(', ')})` : ''}.`,
  'Para não receber mais nada, escreva *chega de oferta*.'
].join('\n');

// Primeiro contato sem pedido: só se apresenta e pede o nome. O texto de boas-vindas (que diz
// "digite o nome do produto") vai depois da resposta, senão o cliente lê "digite o produto" e
// "como posso te chamar?" na mesma mensagem e responde o produto (pedido do usuário em 2026-09-26).
const FIRST_HELLO = 'Olá! 👋 Bem-vindo(a)! Sou o robô de ofertas, cupons e melhores preços. 🔥🛍️\n\nAntes de começar, me conta: como posso te chamar? 😊\n\n👉 Digite só o *seu nome* (o produto que você procura fica pra depois).';

// "para" (preposição) fica de fora de propósito: "oferta para cozinha" não é pedido de saída.
const OPT_OUT_RE = /\b(chega|parar|pare|cancelar?|sair|remover?|descadastrar|n[aã]o quero mais|stop)\b/i;
const OPT_IN_RE = /^\s*(quero\s+ofertas?|come[cç]ar|iniciar|voltar|ativar|start)\s*!*\.?\s*$/i;
const GREETING_RE = /^\s*(oi+|ol[aá]|opa|e a[ií]|bom dia|boa tarde|boa noite|hey|hello|ajuda|help|menu|\?+)[\s!.,]*$/i;
const COUPON_RE = /\bcupo(m|ns)\b|\bdesconto\b/i;
// Palavras que só enfeitam o pedido: "quero uma oferta de fone bluetooth" -> "fone bluetooth".
const FILLER_RE = /\b(quero|queria|gostaria|preciso|procuro|procurando|estou|to|tô|tem|teria|ter|me|manda|mande|mandar|envia|envie|enviar|traz|traga|trazer|ver|uma?|umas?|uns|o|a|os|as|de|do|da|dos|das|em|no|na|pra|para|por|favor|pfv|pf|ofert\w*|promo[cç][aã]o|promo[cç][oõ]es|promo|barato|barata|bom|boa|melhor|melhores|pre[cç]o|cupom|cupons|desconto|com|e|ou|algum|alguma|alguns|algumas|que|qual|quais|voc[eê]|vc|tu|ai|a[ií]|kkk+|rs|pode|ser|prefiro|ent[aã]o|mesmo|mesma|so|somente|apenas|loja)\b|só(?=[\s.,!?]|$)/gi;

// Loja citada pelo cliente: "cupom shopee", "oferta de fone no mercado livre", "os dois".
// Aceita os erros de escrita comuns: "shope", "shopi", "xopee", "mercado libre", "mercadolivre", "mercado" sozinho
// (em 2026-09-26 um cliente respondeu "mercado libre" e o robô achou que era produto novo e perguntou a loja de novo).
const SHOPEE_RE = /\b(shopp?e+|shopi|shopy|shop|xopee?|xopi|chopee)\b/i;
// "ml" depois de número é mililitro ("perfume 100 ml", "100ml"), não Mercado Livre; "mercado" sozinho só
// vale como a mensagem inteira (resposta à pergunta da loja), senão "carrinho de mercado" viraria ML.
const ML_RE = /\bmercado\s*li[bv]r[ei]s?\b|\bmercadoli[bv]r[ei]\b|\bmeli\b|(?<!\d\s?)\bml\b|^\W*mercad[oa]\W*$/i;
const AMAZON_RE = /\b(amazo[nm]|amaz[oô]n|amason|amazom|amzn)\b/i;
const BOTH_RE = /\b(os dois|as duas|nos dois|nas duas|ambos|ambas|todos|todas|tanto faz|qualquer|nenhuma?|indiferente|os 2|as 3|os 3|as tr[eê]s|nas tr[eê]s)\b/i; // "2" sozinho é tratado por numberChoice; aqui apagaria o 2 de "playstation 2"
const STORE_RES: [SearchMarketplace, RegExp][] = [['SHOPEE', SHOPEE_RE], ['MERCADO_LIVRE', ML_RE], ['AMAZON', AMAZON_RE]];
export type MarketplaceChoice = Marketplace | 'ALL';
export function marketplaceIn(text: string): MarketplaceChoice | null {
  const named = STORE_RES.filter(([, re]) => re.test(text)).map(([m]) => m);
  if (named.length > 1) return 'ALL';
  if (named.length) return named[0];
  return BOTH_RE.test(text) ? 'ALL' : null;
}
const stripMarketplace = (text: string) => STORE_RES.reduce((t, [, re]) => t.replace(re, ' '), text).replace(BOTH_RE, ' ');
// Resposta numérica às perguntas de loja ("1", "opção 2", "3."): as lojas do robô na ordem da
// pergunta (1 Shopee, 2 Mercado Livre, 3 Amazon...) e o número seguinte = qualquer uma.
const NUMBER_CHOICE_RE = /^[^\p{L}\d]*(?:(?:a|o|op[cç][aã]o|n[uú]mero|escolho|quero)\s+)?([1-9])(?!\d)[^\p{L}\d]*$/iu;
export function numberChoice(text: string, stores: SearchMarketplace[] = ['SHOPEE', 'MERCADO_LIVRE']): MarketplaceChoice | null {
  const m = NUMBER_CHOICE_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= stores.length ? stores[n - 1] : n === stores.length + 1 ? 'ALL' : null;
}
/** Opções numeradas das perguntas de loja: "*1* 🛍️ Shopee", ..., "*N* 🔀 Qualquer uma". */
function storeOptions(stores: SearchMarketplace[], anyLabel: string) {
  return [...stores.map((s, i) => `*${i + 1}* ${marketplaceIcon(s)} ${marketplaceLabel(s)}`), `*${stores.length + 1}* 🔀 ${anyLabel}`].join('\n');
}
/** "Shopee ou Mercado Livre" / "Shopee, Mercado Livre ou Amazon". */
const storeList = (stores: SearchMarketplace[]) => { const n = stores.map(marketplaceLabel); return n.length > 1 ? `${n.slice(0, -1).join(', ')} ou ${n[n.length - 1]}` : n.join(''); };

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Produtos genéricos demais para uma busca boa. Cliente que manda só "tv" recebe a pergunta
 * de detalhes (`items`) e a resposta dele vira a busca. `re` casa com o pedido inteiro já
 * sem acento/enfeite: "tv 50 polegadas" não casa e vai direto pra busca.
 */
type DetailSpec = { re: RegExp; name: string; items: string[]; example: string };
const DETAILS: DetailSpec[] = [
  { re: /^(smart ?)?(tv|tvs|televis\w*|telinha)$/, name: 'TV', items: ['tamanho (43, 50, 55 polegadas...)', 'marca (Samsung, LG, TCL, Philco...)', 'modelo ou tipo (smart, 4K, QLED...)'], example: 'tv 50 polegadas samsung 4k' },
  { re: /^(celular|celulares|smartphone|smartphones|telefone|telefones|aparelho)$/, name: 'celular', items: ['marca (Samsung, Motorola, Xiaomi, Apple...)', 'modelo (Galaxy A15, Moto G54, iPhone 13...)', 'memória (64, 128, 256 GB)'], example: 'celular samsung galaxy a15 128gb' },
  { re: /^(iphone|iphones)$/, name: 'iPhone', items: ['modelo (11, 13, 15, 16...)', 'memória (128, 256 GB)', 'novo ou seminovo'], example: 'iphone 13 128gb' },
  { re: /^(notebook|notebooks|laptop|computador|computadores|pc)$/, name: 'notebook', items: ['marca (Lenovo, Dell, Acer, Samsung...)', 'processador (i3, i5, Ryzen 5...)', 'memória e SSD (8 GB, 256 GB...)', 'pra que vai usar (estudo, trabalho, jogos)'], example: 'notebook lenovo i5 8gb 256gb' },
  { re: /^(tablet|tablets|ipad)$/, name: 'tablet', items: ['marca (Samsung, Apple, Xiaomi...)', 'tamanho da tela (8, 10, 11 polegadas)', 'memória (64, 128 GB)'], example: 'tablet samsung 10 polegadas 64gb' },
  { re: /^(monitor|monitores)$/, name: 'monitor', items: ['tamanho (24, 27 polegadas...)', 'marca (LG, Samsung, AOC...)', 'tipo (gamer 144Hz, curvo, 4K...)'], example: 'monitor 24 polegadas lg' },
  { re: /^(fone|fones|fone de ouvido|fones de ouvido|headphone|headphones|headset|earbuds?|airpods?)$/, name: 'fone', items: ['tipo (bluetooth, com fio, gamer, intra ou headphone)', 'marca (JBL, Xiaomi, Apple, Samsung...)', 'modelo, se souber'], example: 'fone bluetooth jbl' },
  { re: /^(relogio|relogios|smartwatch|smartwatches|smart ?watch)$/, name: 'relógio', items: ['tipo (smartwatch, digital, analógico)', 'marca (Xiaomi, Samsung, Apple, Casio...)', 'masculino ou feminino'], example: 'smartwatch xiaomi' },
  { re: /^(geladeira|geladeiras|refrigerador|frigobar)$/, name: 'geladeira', items: ['tamanho (litros)', 'marca (Brastemp, Consul, Electrolux...)', 'tipo (frost free, duplex, inverse)'], example: 'geladeira frost free 400 litros brastemp' },
  { re: /^(fogao|fogoes|cooktop)$/, name: 'fogão', items: ['bocas (4, 5, 6)', 'marca (Brastemp, Consul, Atlas...)', 'tipo (piso, embutir, cooktop)'], example: 'fogão 5 bocas brastemp' },
  { re: /^(maquina|maquina de lavar|lavadora|lavadora de roupas|lava e seca|lava roupas)$/, name: 'máquina de lavar', items: ['capacidade (8, 11, 15 kg)', 'marca (Brastemp, Electrolux, Consul...)', 'tipo (lava e seca, abertura superior...)'], example: 'máquina de lavar 11kg electrolux' },
  { re: /^(ar condicionado|ar condicionados|split)$/, name: 'ar-condicionado', items: ['potência (9000, 12000, 18000 BTUs)', 'marca (LG, Samsung, Electrolux...)', 'tipo (split, inverter, portátil)'], example: 'ar condicionado 12000 btus inverter lg' },
  { re: /^(micro ?ondas|microondas)$/, name: 'micro-ondas', items: ['tamanho (20, 30 litros)', 'marca (Electrolux, Panasonic, Consul...)', 'cor'], example: 'micro-ondas 30 litros electrolux' },
  { re: /^(air ?fryer|airfryer|fritadeira|fritadeira eletrica|fritadeira sem oleo)$/, name: 'air fryer', items: ['capacidade (4, 5, 8 litros)', 'marca (Mondial, Philco, Electrolux...)', 'tipo (digital, com visor, dupla)'], example: 'air fryer 5 litros mondial' },
  { re: /^(tenis|sapato|sapatos|calcado|calcados|chinelo|chinelos|sandalia|sandalias|bota|botas)$/, name: 'calçado', items: ['masculino, feminino ou infantil', 'numeração (ex.: 40)', 'marca ou estilo (Nike, Adidas, casual, corrida...)'], example: 'tênis masculino nike 42' },
  { re: /^(roupa|roupas|camiseta|camisetas|camisa|camisas|blusa|blusas|vestido|vestidos|calca|calcas|bermuda|bermudas|short|shorts|jaqueta|jaquetas|moletom|conjunto)$/, name: 'roupa', items: ['masculino, feminino ou infantil', 'tamanho (P, M, G, GG)', 'estilo ou marca'], example: 'camiseta masculina preta G' },
  { re: /^(perfume|perfumes)$/, name: 'perfume', items: ['masculino ou feminino', 'marca ou nome (Natura, Boticário, 212...)', 'tamanho (50, 100 ml)'], example: 'perfume masculino 212 100ml' },
  { re: /^(cadeira|cadeiras|cadeira gamer|cadeira de escritorio)$/, name: 'cadeira', items: ['tipo (gamer, escritório, jantar)', 'cor', 'marca, se souber'], example: 'cadeira gamer preta' },
  { re: /^(sofa|sofas)$/, name: 'sofá', items: ['lugares (2, 3, 4)', 'tipo (retrátil, reclinável, canto)', 'cor ou tecido'], example: 'sofá 3 lugares retrátil cinza' },
  { re: /^(colchao|colchoes)$/, name: 'colchão', items: ['tamanho (solteiro, casal, queen, king)', 'tipo (molas, espuma D33...)', 'marca (Ortobom, Castor...)'], example: 'colchão casal molas ortobom' },
  { re: /^(bicicleta|bicicletas|bike)$/, name: 'bicicleta', items: ['aro (20, 26, 29)', 'tipo (mountain bike, dobrável, infantil)', 'marca'], example: 'bicicleta aro 29 21 marchas' },
  { re: /^(mochila|mochilas|bolsa|bolsas)$/, name: 'mochila', items: ['pra que vai usar (escola, notebook, viagem)', 'tamanho', 'cor ou marca'], example: 'mochila notebook preta' },
  { re: /^(camera|cameras|webcam)$/, name: 'câmera', items: ['tipo (segurança wifi, fotográfica, webcam, ação)', 'marca', 'resolução (Full HD, 4K)'], example: 'câmera de segurança wifi full hd' },
  { re: /^(impressora|impressoras)$/, name: 'impressora', items: ['tipo (tanque de tinta, laser, multifuncional)', 'marca (Epson, HP, Canon)', 'wifi sim ou não'], example: 'impressora multifuncional epson wifi' },
  { re: /^(caixa de som|caixinha de som|caixinha|som)$/, name: 'caixa de som', items: ['tamanho ou potência (portátil, torre, watts)', 'marca (JBL, Xiaomi...)', 'bluetooth sim ou não'], example: 'caixa de som bluetooth jbl' },
  { re: /^(teclado|teclados|mouse|mouses|teclado e mouse)$/, name: '', items: ['tipo (gamer, sem fio, mecânico)', 'marca (Logitech, Redragon...)', 'modelo, se souber'], example: 'teclado mecânico gamer redragon' },
  { re: /^(videogame|video game|console|consoles|playstation|xbox|nintendo)$/, name: 'videogame', items: ['qual (PS5, PS4, Xbox Series S, Switch...)', 'novo ou usado', 'com jogo ou controle extra'], example: 'playstation 5 slim' },
  { re: /^(ventilador|ventiladores)$/, name: 'ventilador', items: ['tamanho (30, 40, 50 cm)', 'tipo (mesa, coluna, parede, teto)', 'marca (Mondial, Arno...)'], example: 'ventilador 40cm coluna mondial' },
  { re: /^(aspirador|aspiradores|aspirador de po|robo aspirador)$/, name: 'aspirador', items: ['tipo (robô, vertical, portátil)', 'marca (Electrolux, Wap, Xiaomi...)', 'com ou sem fio'], example: 'aspirador vertical sem fio' },
  { re: /^(liquidificador|liquidificadores|batedeira|batedeiras|cafeteira|cafeteiras|sanduicheira|panela eletrica|panela de pressao|panela de arroz)$/, name: '', items: ['marca (Mondial, Philco, Arno, Oster...)', 'potência ou capacidade', 'voltagem (110 ou 220)'], example: 'liquidificador mondial 1200w 220v' },
  { re: /^(panela|panelas|jogo de panelas|conjunto de panelas)$/, name: 'panela', items: ['quantas peças', 'material (antiaderente, inox, cerâmica)', 'marca (Tramontina...)'], example: 'jogo de panelas antiaderente 5 peças tramontina' },
  { re: /^(oculos|oculos de sol|oculos de grau)$/, name: 'óculos', items: ['de sol ou de grau', 'masculino ou feminino', 'estilo ou marca (Ray-Ban, esportivo...)'], example: 'óculos de sol masculino ray-ban' },
  { re: /^(brinquedo|brinquedos|presente|presentes)$/, name: 'brinquedo', items: ['idade da criança', 'menino ou menina', 'tipo (boneca, carrinho, educativo, Lego...)'], example: 'brinquedo educativo 3 anos' },
  { re: /^(secador|secadores|secador de cabelo|chapinha|chapinhas|prancha|prancha de cabelo)$/, name: '', items: ['marca (Taiff, Mondial, Philco...)', 'potência (watts)', 'voltagem (110 ou 220)'], example: 'secador de cabelo taiff 2000w' },
  { re: /^(carregador|carregadores|cabo|cabos)$/, name: 'carregador', items: ['pra qual aparelho (iPhone, Samsung, tipo C...)', 'potência (20W, 25W...)', 'original ou compatível'], example: 'carregador tipo c 25w samsung' },
  { re: /^(capa|capas|capinha|capinhas|pelicula|peliculas)$/, name: 'capinha', items: ['modelo do celular (ex.: Galaxy A15, iPhone 13)', 'tipo (transparente, com suporte, antichoque)', 'cor'], example: 'capinha galaxy a15 transparente' },
  { re: /^(pneu|pneus)$/, name: 'pneu', items: ['medida (ex.: 175/65 R14)', 'marca', 'pra carro ou moto'], example: 'pneu 175/65 r14' },
  { re: /^(livro|livros)$/, name: 'livro', items: ['título ou autor', 'tema (romance, autoajuda, infantil...)'], example: 'livro o poder do hábito' },
  { re: /^(suplemento|suplementos|whey|creatina)$/, name: 'suplemento', items: ['qual (whey, creatina, pré-treino)', 'marca (Growth, Integralmédica, Max...)', 'tamanho (500 g, 1 kg)'], example: 'whey protein growth 1kg' },
  { re: /^(fralda|fraldas)$/, name: 'fralda', items: ['tamanho (RN, P, M, G, XG)', 'marca (Pampers, Huggies...)', 'quantidade'], example: 'fralda pampers G 60 unidades' }
];

// Pergunta para produto de uma palavra que não está na lista acima.
const GENERIC_ITEMS = ['marca ou modelo', 'tamanho, capacidade ou potência', 'cor ou tipo, se importar'];
const GENERIC_EXAMPLE = '+ marca + tamanho (ex.: bosch 500w)';

// generic = produto fora da lista (qualquer palavra só): a resposta do cliente nunca é tratada como produto novo.
export type DetailQuestion = { name: string; items: string[]; text: string; generic?: boolean };
/** Pergunta de detalhes para um pedido genérico ("tv"); null se o pedido já é específico. */
export function detailQuestion(keyword: string): DetailQuestion | null {
  const k = fold(keyword);
  let d = DETAILS.find(d => d.re.test(k));
  // Fora da lista mas uma palavra só ("furadeira", "mala"): pergunta genérica. Duas palavras ou
  // mais ("fone bluetooth", "furadeira bosch") e nomes com número ("iphone 13") já são específicos.
  let generic = false;
  if (!d && /^[\p{L}]+$/u.test(k) && k.length >= 3) { generic = true; d = { re: /$^/, name: '', items: GENERIC_ITEMS, example: `${keyword.trim()} ${GENERIC_EXAMPLE}` }; }
  if (!d) return null;
  const name = d.name || keyword.trim();
  const text = [
    `Boa! 👍 Pra achar *${name}* no melhor preço, me diga:`,
    ...d.items.map(i => `• ${i}`),
    '',
    `Exemplo: _${d.example}_`,
    'Se tanto faz, é só responder *tanto faz* que eu te mando as mais vendidas. 😊'
  ].join('\n');
  return { name, items: d.items, text, ...(generic ? { generic: true } : {}) };
}

// Cliente não quer detalhar ("tanto faz", "não sei"): busca o produto genérico mesmo.
const SKIP_DETAIL_RE = /\b(tanto faz|qualquer|nao sei|não sei|sei nao|sei não|sem prefer\w*|nao tenho prefer\w*|não tenho prefer\w*|o que tiver|mais vendid\w*|mais barat\w*|pode ser qualquer)\b/i;
/** A resposta de detalhes já repete o produto ("tv samsung 55")? Senão, o produto é colado na frente. */
function mentionsProduct(base: string, answer: string) {
  const stop = new Set(['de', 'do', 'da', 'e', 'ou']);
  const words = fold(answer).split(' ');
  return fold(base).split(' ').some(w => !stop.has(w) && words.includes(w));
}

export type Intent =
  | { kind: 'OPT_OUT' }
  | { kind: 'OPT_IN' }
  | { kind: 'HELP' }
  // details = pedido genérico ("tv"): o robô pergunta tamanho/marca/modelo antes de buscar.
  | { kind: 'SEARCH'; keyword: string; wantsCoupons: boolean; marketplace?: Marketplace; details?: DetailQuestion }
  | { kind: 'COUPONS'; marketplace?: MarketplaceChoice }
  // Só o nome da loja ("shopee", "mercado livre", "os dois"): resposta à pergunta "cupom de qual loja?".
  | { kind: 'MARKETPLACE'; marketplace: MarketplaceChoice };

/** Interpreta o texto do cliente. */
export function parseIntent(raw: string): Intent {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (OPT_IN_RE.test(text)) return { kind: 'OPT_IN' };
  if (OPT_OUT_RE.test(text) && text.length <= 40) return { kind: 'OPT_OUT' };
  // Menos de 2 letras não é pedido; "tv" e "pc" (2 letras) são.
  if (GREETING_RE.test(text) || text.length < 2) return { kind: 'HELP' };
  const wantsCoupons = COUPON_RE.test(text);
  const choice = marketplaceIn(text);
  const keyword = cleanKeyword(text);
  if (!keyword || keyword.length < 2) {
    if (wantsCoupons) return choice ? { kind: 'COUPONS', marketplace: choice } : { kind: 'COUPONS' };
    // "os dois" sozinho só faz sentido como resposta à pergunta da loja; BOTH_RE pega "2" e "todos", então exige loja ou pergunta pendente (tratado no handler).
    return choice ? { kind: 'MARKETPLACE', marketplace: choice } : { kind: 'HELP' };
  }
  const details = detailQuestion(keyword);
  return { kind: 'SEARCH', keyword, wantsCoupons, ...(choice && choice !== 'ALL' ? { marketplace: choice } : {}), ...(details ? { details } : {}) };
}

/** Só o produto: tira loja, link, enfeites ("quero uma oferta de") e pontuação. */
function cleanKeyword(text: string) {
  return stripMarketplace(text).replace(/https?:\/\/\S+/gi, ' ').replace(FILLER_RE, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Configuração do atendimento do usuário; cria com os padrões na primeira vez. */
export async function getBot(userId: string) {
  return prisma.customerBot.upsert({ where: { userId }, update: {}, create: { userId } });
}

export function botMarketplaces(bot: CustomerBot): SearchMarketplace[] {
  // Sempre na ordem fixa (Shopee, Mercado Livre, Amazon): é a numeração das perguntas de loja.
  const list = (Array.isArray(bot.marketplaces) ? bot.marketplaces : []).filter(isMarketplace);
  return list.length ? MARKETPLACES.filter((m): m is SearchMarketplace => list.includes(m as SearchMarketplace)) : ['SHOPEE', 'MERCADO_LIVRE'];
}

/** Link que o usuário divulga: abre o WhatsApp do número pareado com o texto já digitado. */
export function customerLink(bot: CustomerBot) {
  const me = getWaState().me?.id;
  if (!me) return null;
  const text = (bot.linkText || 'Quero oferta').trim();
  return `https://wa.me/${me.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

/**
 * Primeiro nome do cliente para a mensagem ("Oi, Dionatan!"), sem emoji nem sobrenome; vazio se o
 * WhatsApp não informou nome ou se veio só símbolo. Regra do usuário (2026-09-25): sempre amigável.
 */
export function firstName(customer: { name?: string | null; givenName?: string | null }) {
  const raw = (customer.givenName || customer.name || '').normalize('NFC').split(/\s+/)[0] || '';
  const clean = raw.replace(/[^\p{L}\p{M}'-]/gu, '');
  if (clean.length < 2 || clean.length > 20) return '';
  // "JOÃO" vira "João"; "McDonald" fica como está.
  return clean[0].toUpperCase() + (clean === clean.toUpperCase() ? clean.slice(1).toLowerCase() : clean.slice(1));
}
/** ", Dionatan" ou "" — para encaixar em "Boa, Dionatan!" / "Oi, Dionatan!". */
const vocative = (customer: { name?: string | null; givenName?: string | null }) => { const n = firstName(customer); return n ? `, ${n}` : ''; };

const minutesLeft = (since: Date, everyMinutes: number) => Math.max(1, Math.ceil((since.getTime() + everyMinutes * 60_000 - Date.now()) / 60_000));

async function log(customerId: string, data: { text: string; keyword?: string | null; status: string; replyText?: string | null; offersJson?: any; error?: string | null; marketplace?: Marketplace | null }) {
  return prisma.customerRequest.create({ data: { customerId, ...data, offersJson: data.offersJson ?? undefined } });
}

// via: número que manda (sem ele, o mesmo pelo qual o cliente falou por último).
async function reply(jid: string, text: string, imageUrl?: string, via?: string) {
  await showTyping(jid, Math.min(4000, 800 + text.length * 8), via);
  await sendWhatsAppWebText(jid, text, imageUrl, via);
}

/** Texto de uma oferta para o cliente, com o cupom do marketplace se houver um válido que caiba. */
async function offerText(o: ShopeeOffer, coupons: Awaited<ReturnType<typeof productCoupons>>, customerId: string) {
  const marketplace = (o.marketplace || 'SHOPEE') as Marketplace;
  // Shopee: link marcado com o cliente (subId "c<cliente>") para a tela de Vendas mostrar quem comprou.
  const affiliateUrl = (marketplace === 'SHOPEE' && await shopeeTrackedLink(o.productUrl, `c${customerId}`)) || o.affiliateUrl;
  return renderOffer(defaultOfferTemplate(), {
    title: o.title, price: o.price, oldPrice: o.oldPrice, discountPercent: o.discountPercent,
    couponText: pickCoupon(coupons, { marketplace, price: o.price ?? null }), affiliateUrl
  });
}

// Cliente que manda "cupom" várias vezes seguidas ganha o listão de novo só depois desse tempo.
const COUPON_REPEAT_MS = 3 * 60_000;

/**
 * Listões de cupom para o cliente, um por marketplace que o robô usa: cupons válidos + link do
 * usuário (agenda da tela Cupons). Marketplace com link mas sem cupom cadastrado (caso da Shopee,
 * que não expõe cupom por API) sai só com o link "resgate seu cupom"; sem cupom e sem link não sai.
 * Mercado Livre sem cupom válido tenta importar do canal do Telegram antes de responder.
 */
async function couponMessages(userId: string, marketplaces: SearchMarketplace[]) {
  const out: string[] = [];
  for (const m of MARKETPLACES.filter(m => marketplaces.includes(m))) {
    const sch = await getSchedule(userId, m);
    let list = await usableCoupons(userId, m);
    if (!list.length && sch.telegramChannel) {
      try { await importTelegramCoupons(userId, m, sch.telegramChannel); list = await usableCoupons(userId, m); }
      catch (e: any) { console.error(`[clientes] importar cupons @${sch.telegramChannel}: ${e.message}`); }
    }
    if (list.length || sch.link) out.push(couponListMessage(m, list, sch.link));
  }
  return out;
}

/** Lojas que o robô usa, restritas à escolha do cliente (escolha que o robô não usa = todas). */
function chosenMarketplaces(bot: CustomerBot, choice?: MarketplaceChoice | null): SearchMarketplace[] {
  const all = botMarketplaces(bot);
  if (!choice || choice === 'ALL') return all;
  return all.includes(choice) ? [choice] : all;
}

/** Quanto tempo a pergunta "cupom de qual loja?" espera a resposta do cliente. */
const ASK_TTL_MS = 15 * 60_000;
const askText = (stores: SearchMarketplace[]) =>
  `🎟️ Claro! Cupom de qual loja você quer?\n\n👉 *Escolher:*\n${storeOptions(stores, stores.length === 2 ? 'Os dois' : 'Todas')}\n\nResponda com o número ou o nome da loja. 😊`;

/**
 * Responde "cupom": manda os listões da(s) loja(s) escolhida(s), ou avisa que não tem.
 * Fora do limite por tempo das ofertas. A mesma escolha repetida em menos de 3 min fica só registrada.
 */
async function sendCouponsTo(bot: CustomerBot, customer: Customer, text: string, choice?: MarketplaceChoice | null) {
  const marketplaces = chosenMarketplaces(bot, choice);
  const key = marketplaces.join(',');
  const recent = await prisma.customerRequest.findFirst({ where: { customerId: customer.id, status: 'COUPONS', keyword: key, createdAt: { gt: new Date(Date.now() - COUPON_REPEAT_MS) } }, select: { id: true } });
  if (recent) { await log(customer.id, { text, keyword: key, status: 'COUPONS_REPEAT' }); return; }
  const texts = bot.sendCoupons ? await couponMessages(customer.userId, marketplaces) : [];
  const loja = marketplaces.length === 1 ? ` ${storeOf(marketplaces[0])}` : '';
  const replyText = texts.length ? texts.join('\n\n') : `Poxa${vocative(customer)}, no momento não tenho cupom válido${loja}. 😕 Mas me diga um produto e eu busco a melhor oferta pra você! 😊`;
  for (const t of texts.length ? texts : [replyText]) await reply(customer.jid, t);
  await prisma.customer.update({ where: { id: customer.id }, data: { requestCount: { increment: 1 } } });
  await log(customer.id, { text, keyword: key, status: 'COUPONS', replyText });
}

/** Cliente pediu cupom sem dizer a loja: pergunta (só se o robô usa mais de uma loja). */
async function askMarketplace(bot: CustomerBot, customer: Customer, text: string) {
  if (botMarketplaces(bot).length < 2) return sendCouponsTo(bot, customer, text);
  const ask = askText(botMarketplaces(bot));
  await reply(customer.jid, ask);
  await log(customer.id, { text, status: 'ASK', replyText: ask });
}

/** Há uma pergunta "cupom de qual loja?" recente sem resposta? */
async function pendingAsk(customerId: string) {
  const last = await prisma.customerRequest.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true } });
  return !!last && last.status === 'ASK' && Date.now() - last.createdAt.getTime() < ASK_TTL_MS;
}

// "oi, meu nome é Ana Paula" -> "Ana Paula". Saudação e "meu nome é / me chamo / sou o" saem.
const NAME_PREFIX_RE = /^(?:(?:oi+|ol[aá]|opa|e a[ií]|bom dia|boa tarde|boa noite|tudo bem|prazer)[\s,!.]*)*(?:(?:meu nome [eé]|me chamo|pode me chamar de|chama de|eu sou [oa]|eu sou|sou [oa]|sou|aqui [eé] [oa]|aqui [eé]|[eé] [oa]|[eé]|o meu [eé]|nome:?)\s+)?/i;
const NOT_A_NAME_RE = /\b(n[aã]o|sim|ok|okay|obrigad[oa]|valeu|nada|ningu[eé]m|prefiro|kkk+|rs|quero|queria|preciso|procuro|oferta|ofertas|promo\w*|cupom|cupons|desconto|barato|manda|envia|tanto faz|qualquer|sei)\b/i;
/** Extrai o nome da resposta a "como posso te chamar?"; null quando a mensagem não parece um nome. */
export function nameAnswer(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60 || /\d/.test(t)) return null;
  if (OPT_OUT_RE.test(t) || OPT_IN_RE.test(t) || COUPON_RE.test(t) || marketplaceIn(t) || GREETING_RE.test(t) || NOT_A_NAME_RE.test(t)) return null;
  const rest = t.replace(NAME_PREFIX_RE, '').replace(/[^\p{L}\p{M}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = rest.split(' ').filter(Boolean);
  if (!words.length || words.length > 4 || words.some(w => w.length < 2)) return null;
  // "tv", "celular", "fone de ouvido": é pedido, não nome.
  const d = detailQuestion(rest);
  if (d && !d.generic) return null;
  // "ana paula de souza" -> "Ana Paula de Souza"; "maria-eduarda" -> "Maria-Eduarda".
  const cap = (w: string) => w.split('-').map(x => x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x).join('-');
  return words.map((w, i) => i > 0 && /^(de|da|do|das|dos|e)$/i.test(w) ? w.toLowerCase() : cap(w)).join(' ');
}

/** A pergunta "como posso te chamar?" foi feita há pouco e ainda espera resposta? Devolve o pedido que ficou guardado. */
const ASK_NAME_TTL_MS = 24 * 60 * 60_000;
async function pendingAskName(customerId: string) {
  const last = await prisma.customerRequest.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { status: true, keyword: true, createdAt: true } });
  return last && last.status === 'ASK_NAME' && Date.now() - last.createdAt.getTime() < ASK_NAME_TTL_MS ? { request: last.keyword || null } : null;
}

/** Quanto tempo a pergunta de detalhes ("tamanho, marca, modelo?") espera a resposta. */
const DETAIL_TTL_MS = 30 * 60_000;
/** Produto genérico cuja pergunta de detalhes foi feita há pouco e ainda não teve resposta ("tv"), ou null. */
async function pendingDetail(customerId: string) {
  const last = await prisma.customerRequest.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { status: true, keyword: true, createdAt: true } });
  return last && last.status === 'DETAIL' && last.keyword && Date.now() - last.createdAt.getTime() < DETAIL_TTL_MS ? last.keyword : null;
}

// marketplaceAsked = o cliente já respondeu "em qual loja?" (não perguntar de novo).
type SearchRequest = { keyword: string; wantsCoupons: boolean; marketplace?: Marketplace; marketplaceAsked?: boolean };
/**
 * Interpreta a mensagem como resposta à pergunta de detalhes de `base` ("tv"):
 * "55 samsung" -> "tv 55 samsung"; "tv lg 50" já cita o produto e fica como está; "tanto faz" ou
 * "tv" de novo -> busca "tv"; "shopee" -> "tv" só na Shopee. Devolve null quando a mensagem é
 * outra coisa (saudação, cupom, outro produto genérico) e deve seguir o caminho normal.
 */
export function detailAnswer(base: string, text: string, intent: Intent): SearchRequest | null {
  if (SKIP_DETAIL_RE.test(text)) return { keyword: base, wantsCoupons: COUPON_RE.test(text) };
  if (intent.kind === 'SEARCH') {
    if (fold(intent.keyword) === fold(base)) return { keyword: base, wantsCoupons: intent.wantsCoupons, marketplace: intent.marketplace };
    if (intent.details && !intent.details.generic) return null;
    const keyword = mentionsProduct(base, intent.keyword) ? intent.keyword : `${base} ${intent.keyword}`;
    return { keyword: keyword.slice(0, 80), wantsCoupons: intent.wantsCoupons, marketplace: intent.marketplace };
  }
  // "55", "lg": curto demais pra ser pedido sozinho, mas é resposta válida.
  if (intent.kind === 'HELP') {
    const k = cleanKeyword(text);
    if (!k || GREETING_RE.test(text)) return null;
    return { keyword: fold(k) === fold(base) ? base : `${base} ${k}`.slice(0, 80), wantsCoupons: false };
  }
  if (intent.kind === 'MARKETPLACE') return { keyword: base, wantsCoupons: false, ...(intent.marketplace !== 'ALL' ? { marketplace: intent.marketplace } : {}) };
  return null;
}

/** Quanto tempo a pergunta "em qual loja busco X?" espera a resposta do cliente. */
const STORE_TTL_MS = 30 * 60_000;
/** Pergunta "em qual loja?" feita há pouco e sem resposta: devolve o pedido guardado, ou null. */
async function pendingStore(customerId: string) {
  const last = await prisma.customerRequest.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' }, select: { status: true, keyword: true, text: true, createdAt: true } });
  if (!last || last.status !== 'ASK_STORE' || !last.keyword || Date.now() - last.createdAt.getTime() >= STORE_TTL_MS) return null;
  return { keyword: last.keyword, wantsCoupons: COUPON_RE.test(last.text) };
}
/**
 * Interpreta a mensagem como resposta a "em qual loja busco `keyword`?": "shopee" -> só Shopee,
 * "mercado livre"/"ml" -> só ML, "qualquer uma"/"tanto faz"/"as duas" -> todas. Outro produto,
 * cupom ou saudação -> null (segue o caminho normal).
 */
export function storeAnswer(pending: { keyword: string; wantsCoupons: boolean }, text: string, intent: Intent, stores?: SearchMarketplace[]): SearchRequest | null {
  const base: SearchRequest = { keyword: pending.keyword, wantsCoupons: pending.wantsCoupons || COUPON_RE.test(text), marketplaceAsked: true };
  // "1", "2", "3"... (opções da pergunta) vêm antes de tudo: "2" sozinho também casa com BOTH_RE ("os 2").
  const num = numberChoice(text, stores);
  if (num) return { ...base, ...(num !== 'ALL' ? { marketplace: num } : {}) };
  // "tanto faz", "não sei", "nenhuma preferência", "os dois": todas as lojas (mesma regra da pergunta de detalhes).
  if (SKIP_DETAIL_RE.test(text) || marketplaceIn(text) === 'ALL') return base;
  if (intent.kind === 'MARKETPLACE') return { ...base, ...(intent.marketplace !== 'ALL' ? { marketplace: intent.marketplace } : {}) };
  // "shopee com cupom": escolheu a loja e quer o listão junto.
  if (intent.kind === 'COUPONS' && intent.marketplace) return { ...base, wantsCoupons: true, ...(intent.marketplace !== 'ALL' ? { marketplace: intent.marketplace } : {}) };
  // "fone bluetooth na shopee": repetiu o produto já com a loja.
  if (intent.kind === 'SEARCH' && intent.marketplace && fold(intent.keyword) === fold(pending.keyword)) return { ...base, marketplace: intent.marketplace };
  if (intent.kind === 'HELP' && SKIP_DETAIL_RE.test(text)) return base;
  return null;
}
/** Texto da pergunta "em qual loja?". */
export function storeQuestion(keyword: string, customer: { name?: string | null; givenName?: string | null }, stores: SearchMarketplace[] = ['SHOPEE', 'MERCADO_LIVRE']) {
  return `🛒 Em qual loja você quer que eu busque *${keyword}*${vocative(customer)}?\n\n👉 *Escolher:*\n${storeOptions(stores, 'Qualquer uma')}\n\nResponda com o número ou o nome da loja. 😊`;
}

const storeName = storeIn;

/**
 * Busca e envia as ofertas de `keyword` para o cliente. Usado pela resposta automática e pelo
 * botão "Enviar oferta" da tela (aí sem limite por tempo). Devolve quantas ofertas saíram.
 */
export async function sendOffersTo(bot: CustomerBot, customer: Customer, keyword: string, opts: { wantsCoupons?: boolean; marketplace?: Marketplace; text?: string; manual?: boolean } = {}) {
  // "fone na shopee" busca só na Shopee (se o robô a usa); sem loja no pedido, todas.
  const marketplaces = chosenMarketplaces(bot, opts.marketplace);
  const limit = Math.min(10, Math.max(1, bot.maxOffers || 3));
  let offers: ShopeeOffer[] = [];
  let level: MatchLevel | 'none' = 'strict';
  try {
    // As buscas dos marketplaces são frouxas ("tv 50 polegadas" traz suporte de TV e TV 32), então
    // pede bem mais candidatos por loja e filtra pelo título (offer-match). Shopee: relevância +
    // mais vendidos (quem aparece bem nos dois sobe); ML só tem mais vendidos da categoria; Amazon, relevância.
    const per = Math.min(25, Math.max(12, limit * 6));
    const errors: any[] = [];
    // DEALS: entre o que bate com o pedido, os de maior desconto (que vendem bem) vão primeiro.
    const sortsFor = (m: SearchMarketplace) => m === 'SHOPEE' ? ['RELEVANCE', 'SALES', 'DEALS'] : m === 'AMAZON' ? ['RELEVANCE', 'DEALS'] : ['SALES', 'DEALS'];
    const lists = await Promise.all(marketplaces.map(m =>
      searchOffers(customer.userId, { marketplaces: [m], keywords: [keyword], sorts: sortsFor(m), limit: per, termFilter: false })
        .then(l => filterByRequest(l, keyword)).catch(e => { errors.push(e); return { offers: [] as ShopeeOffer[], level: 'none' as const }; })));
    if (errors.length === marketplaces.length) throw errors[0];
    // Tudo batendo em alguma loja vale mais que "parecido" na outra.
    const best = lists.some(l => l.level === 'strict') ? 'strict' : lists.some(l => l.level === 'relaxed') ? 'relaxed' : 'none';
    level = best;
    const chosen = lists.filter(l => l.level === best).map(l => l.offers);
    // Intercala as lojas e descarta anúncios com o mesmo título, para o cliente receber produtos
    // DIFERENTES e não 3 vezes o mesmo. Ordem dentro de cada loja = mais vendidos.
    const seen = new Set<string>();
    const longest = Math.max(0, ...chosen.map(l => l.length));
    for (let i = 0; i < longest && offers.length < limit; i++) for (const l of chosen) {
      const o = l[i]; if (!o) continue;
      const k = titleKey(o.title) || o.itemId;
      if (seen.has(k)) continue;
      seen.add(k); offers.push(o);
      if (offers.length >= limit) break;
    }
  } catch (e: any) {
    await log(customer.id, { text: opts.text || keyword, keyword, status: 'FAILED', error: e.message });
    if (!opts.manual) await reply(customer.jid, `Ops, desculpa${vocative(customer)}! 😅 Não consegui buscar *${keyword}* agora. Pode tentar de novo em alguns minutinhos? 🙏`).catch(() => {});
    throw e;
  }
  const coupons = bot.sendCoupons ? await productCoupons(customer.userId) : [];
  const couponTexts = opts.wantsCoupons && bot.sendCoupons ? await couponMessages(customer.userId, marketplaces) : [];
  // Cliente escolheu uma loja: a resposta diz onde achou (ou não achou) e lembra que dá pra pedir na outra.
  const where = marketplaces.length === 1 ? ` ${storeName(marketplaces[0])}` : '';
  const other = marketplaces.length === 1 ? botMarketplaces(bot).find(m => m !== marketplaces[0]) : undefined;

  if (!offers.length) {
    const text = couponTexts.length
      ? `Poxa${vocative(customer)}, não achei ofertas de *${keyword}*${where} agora. 😕 Mas aqui vão os cupons de hoje pra você:`
      : `Poxa${vocative(customer)}, não achei ofertas de *${keyword}*${where} agora. 😕\n\nPode tentar mudar a marca, o tamanho ou o modelo (ex.: _tv 50 polegadas lg_)${other ? ` ou pedir em outra loja (ex.: _${keyword} ${storeName(other)}_)` : ''} que eu busco de novo pra você! 😊`;
    await reply(customer.jid, text);
    for (const c of couponTexts) await reply(customer.jid, c);
    await log(customer.id, { text: opts.text || keyword, keyword, status: opts.manual ? 'MANUAL' : 'EMPTY', replyText: text, offersJson: [] });
    return 0;
  }

  const intro = level === 'relaxed'
    ? `Não achei exatamente *${keyword}*${vocative(customer)}, mas separei ${offers.length === 1 ? 'uma opção parecida' : `${offers.length} opções parecidas`} que podem te interessar! 😊👇`
    : offers.length === 1 ? `Boa${vocative(customer)}! Achei esta oferta de *${keyword}*${where} pra você! 🎉👇` : `Boa${vocative(customer)}! Achei ${offers.length} ofertas de *${keyword}*${where} pra você! 🎉👇`;
  await reply(customer.jid, intro);
  const sent: any[] = [];
  for (const o of offers) {
    const text = await offerText(o, coupons, customer.id);
    await reply(customer.jid, text, o.imageUrl);
    sent.push({ itemId: o.itemId, title: o.title, price: o.price, oldPrice: o.oldPrice, imageUrl: o.imageUrl, affiliateUrl: o.affiliateUrl, marketplace: o.marketplace || marketplaces[0] });
  }
  for (const c of couponTexts) await reply(customer.jid, c);
  if (opts.wantsCoupons && bot.sendCoupons && !couponTexts.length) await reply(customer.jid, 'No momento não tenho cupom válido, mas as ofertas acima já estão com o melhor preço que encontrei. 😉 Qualquer outro produto, é só me chamar!');

  await prisma.customer.update({ where: { id: customer.id }, data: { requestCount: { increment: 1 }, lastRequestAt: opts.manual ? undefined : new Date() } });
  await log(customer.id, { text: opts.text || keyword, keyword, status: opts.manual ? 'MANUAL' : 'ANSWERED', replyText: intro, offersJson: sent });
  return offers.length;
}

/** Manda um texto livre para o cliente (botão da tela). */
export async function sendTextTo(customer: Customer, text: string) {
  await reply(customer.jid, text);
  await log(customer.id, { text: '(painel)', status: 'MANUAL', replyText: text });
}

/** Convite para entrar no grupo de ofertas (tela Clientes, 2026-10-08): fica no histórico como INVITE. */
export async function sendInviteTo(customer: Customer, text: string, via?: string) {
  await reply(customer.jid, text, undefined, via);
  await log(customer.id, { text: '(convite para o grupo)', status: 'INVITE', replyText: text });
}

/** Qual usuário atende o privado: o único que tem o atendimento ligado (a sessão do WhatsApp é uma só). */
async function activeBot() {
  return prisma.customerBot.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
}

async function handleIncoming(m: WaIncoming) {
  const bot = await activeBot();
  if (!bot) return;
  const customer = await prisma.customer.upsert({
    where: { userId_jid: { userId: bot.userId, jid: m.jid } },
    create: { userId: bot.userId, jid: m.jid, phone: m.phone, name: m.name },
    update: { lastSeenAt: new Date(), ...(m.name ? { name: m.name } : {}), ...(m.phone ? { phone: m.phone } : {}) }
  });
  // Bloqueado pelo botão da tela: o único caso em que o cliente fica sem resposta, de propósito.
  if (customer.blocked) { await log(customer.id, { text: m.text || `(${m.media})`, status: 'BLOCKED' }); return; }

  // Áudio, foto, figurinha...: o robô não entende, mas responde e pede o produto por escrito.
  if (!m.text) {
    const what = m.media === 'audio' ? 'ouvir áudio' : m.media === 'sticker' ? 'ver figurinha' : m.media === 'video' ? 'ver vídeo' : m.media === 'image' ? 'ver foto' : 'abrir esse tipo de mensagem';
    const text = `Oi${vocative(customer)}! 😊 Ainda não consigo ${what} por aqui. 🙈\n\nMe escreve o nome do produto que você procura (ex.: _tv 50 polegadas samsung_) que eu busco as melhores ofertas pra você!`;
    await reply(m.jid, text);
    await log(customer.id, { text: `(${m.media})`, status: 'MEDIA', replyText: text });
    return;
  }

  const intent = parseIntent(m.text);

  if (intent.kind === 'OPT_OUT') {
    await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: true } });
    const text = `Combinado${vocative(customer)}! 🙂 Não vou mais te mandar ofertas.\n\nSe mudar de ideia, é só escrever *quero oferta* que eu volto na hora. Obrigado por falar comigo! 👋`;
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'OPT_OUT', replyText: text });
    return;
  }
  // Nome: primeira conversa pergunta "como posso te chamar?" e guarda o pedido que veio junto.
  if (!customer.givenName) {
    if (!customer.nameAskedAt) {
      const request = intent.kind === 'SEARCH' || intent.kind === 'COUPONS' ? m.text : null;
      const text = intent.kind === 'SEARCH'
        ? `Oi! 😊 Já vou buscar *${intent.keyword}* pra você. Só antes, me conta: como posso te chamar?`
        : intent.kind === 'COUPONS'
          ? 'Oi! 😊 Já te mando os cupons. Só antes, me conta: como posso te chamar?'
          : FIRST_HELLO;
      await reply(m.jid, text);
      await prisma.customer.update({ where: { id: customer.id }, data: { nameAskedAt: new Date(), lastNoticeAt: new Date(), ...(intent.kind === 'OPT_IN' ? { optedOut: false } : {}) } });
      await log(customer.id, { text: m.text, keyword: request, status: 'ASK_NAME', replyText: text });
      return;
    }
    const pending = await pendingAskName(customer.id);
    const name = pending ? nameAnswer(m.text) : null;
    if (pending && name) {
      await prisma.customer.update({ where: { id: customer.id }, data: { givenName: name } });
      customer.givenName = name;
      const first = firstName(customer);
      if (pending.request) {
        // O pedido que ficou esperando o nome é atendido agora.
        const text = `Prazer, ${first}! 😊 Já vou buscar pra você.`;
        await reply(m.jid, text);
        await log(customer.id, { text: m.text, status: 'NAME', replyText: text });
        return handleIncoming({ ...m, text: pending.request });
      }
      // Só agora vai o texto de boas-vindas (o da tela Clientes ou o padrão), que explica como pedir o produto.
      const text = `Prazer, ${first}! 😊\n\n${bot.welcomeText?.trim() || defaultWelcome(botMarketplaces(bot))}`;
      await reply(m.jid, text);
      await log(customer.id, { text: m.text, status: 'NAME', replyText: text });
      return;
    }
    // Respondeu com um pedido em vez do nome: atende normalmente, sem insistir (fica o nome do perfil).
  }

  if (intent.kind === 'OPT_IN') {
    await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: false } });
    const text = bot.welcomeText?.trim() || defaultWelcome(botMarketplaces(bot));
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'OPT_IN', replyText: text });
    return;
  }
  // Cliente que pediu "chega": nada de oferta, mas lembra como voltar (ninguém fica sem resposta).
  if (customer.optedOut) {
    const text = `Oi${vocative(customer)}! 😊 Como você pediu, não estou te mandando ofertas.\n\nSe quiser voltar a receber, é só escrever *quero oferta*. Estou por aqui! 👋`;
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'OPT_OUT', replyText: text });
    return;
  }

  // Resposta à pergunta de detalhes ("tamanho, marca, modelo?") feita há pouco.
  const base = await pendingDetail(customer.id);
  let search: SearchRequest | null = base ? detailAnswer(base, m.text, intent) : null;
  // Resposta à pergunta "em qual loja busco X?" feita há pouco (só uma das duas perguntas pode ser a última).
  if (!search && !base) {
    const pending = await pendingStore(customer.id);
    if (pending) search = storeAnswer(pending, m.text, intent, botMarketplaces(bot));
  }

  // "1", "2", "3"... respondendo à pergunta "cupom de qual loja?" (a da oferta já foi tratada em storeAnswer).
  if (!search) {
    const num = numberChoice(m.text, botMarketplaces(bot));
    if (num && await pendingAsk(customer.id)) { await sendCouponsTo(bot, customer, m.text, num); return; }
  }

  if (!search && intent.kind === 'HELP') {
    // Saudação repetida dentro de 10 min ganha só uma linha, não o menu inteiro de novo.
    const repeated = !!customer.lastNoticeAt && Date.now() - customer.lastNoticeAt.getTime() < 10 * 60_000;
    const text = repeated ? `Estou aqui pra te ajudar${vocative(customer)}! 😊 Me diga o produto que você procura (ex.: _fone bluetooth_, _tv 50 polegadas_) ou escreva *cupom*.` : (bot.welcomeText?.trim() || defaultWelcome(botMarketplaces(bot)));
    await reply(m.jid, text);
    if (!repeated) await prisma.customer.update({ where: { id: customer.id }, data: { lastNoticeAt: new Date() } });
    await log(customer.id, { text: m.text, status: 'HELP', replyText: text });
    return;
  }

  // Só cupom: responde na hora, sem gastar a janela de ofertas do cliente. Sem a loja, pergunta.
  if (!search && intent.kind === 'COUPONS') {
    if (intent.marketplace) await sendCouponsTo(bot, customer, m.text, intent.marketplace);
    else await askMarketplace(bot, customer, m.text);
    return;
  }
  // Só o nome da loja: é a resposta da pergunta acima (se ela foi feita há pouco).
  if (!search && intent.kind === 'MARKETPLACE') {
    if (await pendingAsk(customer.id)) { await sendCouponsTo(bot, customer, m.text, intent.marketplace); return; }
    const text = `Claro${vocative(customer)}! 😊 Me diga o produto que você procura (ex.: _fone bluetooth_) ou escreva *cupom* que eu te ajudo.`;
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, status: 'HELP', replyText: text });
    return;
  }

  if (!search) {
    if (intent.kind !== 'SEARCH') return;
    // Pedido genérico ("tv"): pergunta tamanho/marca/modelo antes de buscar. Não gasta o limite por tempo.
    if (intent.details) {
      await reply(m.jid, intent.details.text.replace(/^Boa!/, `Boa${vocative(customer)}!`));
      await log(customer.id, { text: m.text, keyword: intent.keyword, status: 'DETAIL', replyText: intent.details.text });
      return;
    }
    search = { keyword: intent.keyword, wantsCoupons: intent.wantsCoupons, marketplace: intent.marketplace };
  }

  // Sem a loja no pedido: pergunta "Shopee, Mercado Livre ou qualquer uma?" antes de buscar, se a
  // opção está ligada e o robô usa as duas. Não gasta o limite por tempo e vem ANTES dele: a loja
  // fica escolhida e, quando o limite passar, a busca sai sozinha já na loja certa.
  if (bot.askMarketplace !== false && !search.marketplace && !search.marketplaceAsked && botMarketplaces(bot).length > 1) {
    const text = storeQuestion(search.keyword, customer, botMarketplaces(bot));
    await reply(m.jid, text);
    await log(customer.id, { text: m.text, keyword: search.keyword, status: 'ASK_STORE', replyText: text });
    return;
  }

  // Limite por tempo: uma busca de ofertas por cliente a cada everyMinutes. O pedido fica guardado
  // (LIMITED, keyword + loja) e deliverPendingSearches manda as ofertas sozinho quando o limite passar.
  if (customer.lastRequestAt && Date.now() - customer.lastRequestAt.getTime() < bot.everyMinutes * 60_000) {
    const left = minutesLeft(customer.lastRequestAt, bot.everyMinutes);
    const keyword = search.keyword;
    // Primeira vez na janela: aviso completo; depois, só uma linha, mas sempre responde.
    const first = !customer.lastNoticeAt || customer.lastNoticeAt < customer.lastRequestAt;
    const text = first
      ? `Opa${vocative(customer)}! Acabei de te mandar ofertas há pouquinho. 😉 Em *${left} min* eu busco *${keyword}* e te mando aqui automaticamente, sem precisar pedir de novo!`
      : `Só mais *${left} min* e eu te mando *${keyword}* automaticamente! 😊 Não precisa pedir de novo.`;
    await reply(m.jid, text);
    if (first) await prisma.customer.update({ where: { id: customer.id }, data: { lastNoticeAt: new Date() } });
    await log(customer.id, { text: m.text, keyword, status: 'LIMITED', replyText: text, marketplace: search.marketplace ?? null });
    // Pediu oferta COM cupom: os cupons ele pode receber já; só a busca espera.
    if (search.wantsCoupons) await sendCouponsTo(bot, customer, m.text, search.marketplace).catch(() => {});
    return;
  }

  // sendOffersTo já avisa o cliente ("Ops, não consegui buscar...") quando a busca falha.
  await sendOffersTo(bot, customer, search.keyword, { wantsCoupons: search.wantsCoupons, marketplace: search.marketplace, text: m.text }).catch(() => {});
}

/**
 * Entrega automática depois do limite (pedido do usuário em 2026-09-26): quem ouviu "em X min eu te
 * mando" recebe as ofertas sozinho quando o limite passa, sem pedir de novo. O pedido está no
 * CustomerRequest LIMITED mais novo do cliente (keyword + loja escolhida). Ao entregar, o registro
 * vira LIMITED_SENT (os LIMITED mais antigos do mesmo cliente também), para nunca repetir; se o
 * cliente já pediu de novo depois do limite, o LIMITED antigo só é marcado. Roda a cada 30 s.
 */
async function deliverPendingSearches() {
  const bot = await activeBot();
  if (!bot || !anyWaConnected()) return;
  const pending = await prisma.customerRequest.findMany({
    where: { status: 'LIMITED', keyword: { not: null }, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) }, customer: { userId: bot.userId, blocked: false, optedOut: false } },
    orderBy: { createdAt: 'desc' },
    include: { customer: true }
  });
  const seen = new Set<string>();
  for (const r of pending) {
    const c = r.customer;
    // Só o pedido mais novo de cada cliente vale; pedido anterior à última entrega já foi atendido.
    // Linhas antigas de "cupom repetido" gravavam a loja ("SHOPEE,MERCADO_LIVRE") como LIMITED: não é busca.
    const notSearch = /^(SHOPEE|MERCADO_LIVRE|AMAZON)(,(SHOPEE|MERCADO_LIVRE|AMAZON))*$/.test(r.keyword || '');
    if (notSearch) { await prisma.customerRequest.update({ where: { id: r.id }, data: { status: 'COUPONS_REPEAT' } }); continue; }
    const superseded = seen.has(c.id) || (!!c.lastRequestAt && c.lastRequestAt > r.createdAt);
    seen.add(c.id);
    if (superseded) { await prisma.customerRequest.update({ where: { id: r.id }, data: { status: 'LIMITED_SENT' } }); continue; }
    if (c.lastRequestAt && Date.now() - c.lastRequestAt.getTime() < bot.everyMinutes * 60_000) continue; // ainda dentro do limite
    // Marca antes de enviar: se a busca falhar, sendOffersTo avisa o cliente e registra FAILED (não fica tentando para sempre).
    await prisma.customerRequest.update({ where: { id: r.id }, data: { status: 'LIMITED_SENT' } });
    enqueue(c.jid, () => sendOffersTo(bot, c, r.keyword!, { marketplace: r.marketplace ?? undefined, text: `(automático) ${r.text}` }).then(() => undefined));
  }
}

// Fila por cliente: duas mensagens seguidas do mesmo número (ou a entrega automática) são tratadas uma depois da outra.
const chains = new Map<string, Promise<void>>();
function enqueue(jid: string, task: () => Promise<void>) {
  const prev = chains.get(jid) || Promise.resolve();
  const next = prev.then(task).catch(e => console.error('[clientes]', e?.message || e)).finally(() => { if (chains.get(jid) === next) chains.delete(jid); });
  chains.set(jid, next);
  return next;
}
export function startCustomerBot() {
  setInterval(() => deliverPendingSearches().catch(e => console.error('[clientes] entrega automática:', e?.message || e)), 30_000);
  onWhatsAppMessage(m => {
    const prev = chains.get(m.jid) || Promise.resolve();
    const next = prev.then(() => handleIncoming(m)).catch(async e => {
      console.error('[clientes]', e?.message || e);
      // Deu erro antes de responder (banco, WhatsApp...): ainda assim o cliente recebe uma linha.
      await reply(m.jid, 'Ops, desculpa! 😅 Tive um probleminha aqui. Pode mandar de novo daqui a pouquinho? Estou por aqui pra te ajudar!').catch(() => {});
    }).finally(() => { if (chains.get(m.jid) === next) chains.delete(m.jid); });
    chains.set(m.jid, next);
    return next;
  });
}
