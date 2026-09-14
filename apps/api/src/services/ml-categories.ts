import fs from 'node:fs';
import path from 'node:path';

/**
 * Árvore de categorias do Mercado Livre, usada pelo campo "Digite um nicho" da busca automática:
 * o usuário digita "infantil" e recebe todas as categorias ligadas a isso para marcar.
 *
 * O recurso /categories/{id} é público (responde sem token, testado em 2026-09-14) e devolve o nome,
 * o caminho desde a raiz e as subcategorias (nome + quantidade de anúncios). A raiz /sites/MLB/categories
 * dá 403 sem token, então a lista de raízes fica fixa aqui (ids verificados em 2026-09-14).
 *
 * Como são ~450 categorias só nos dois primeiros níveis, a árvore é montada em segundo plano quando a API
 * sobe e guardada em disco (apps/api/.cache/ml-categories.json) por 7 dias. Categorias que casam com a
 * busca são aprofundadas na hora (filhas das filhas), também em cache.
 */

const API = 'https://api.mercadolibre.com';
const CACHE_FILE = path.resolve(__dirname, '../../.cache/ml-categories.json');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const CONCURRENCY = 8;

// Raízes que interessam para afiliado (fora Imóveis, Serviços e Ingressos).
export const ROOTS = ['MLB5672', 'MLB271599', 'MLB1403', 'MLB1071', 'MLB1367', 'MLB1368', 'MLB1384', 'MLB1246', 'MLB1132', 'MLB1430', 'MLB1039', 'MLB1743', 'MLB1574', 'MLB1051', 'MLB1500', 'MLB5726', 'MLB1000', 'MLB1276', 'MLB263532', 'MLB12404', 'MLB1144', 'MLB1499', 'MLB1648', 'MLB1182', 'MLB3937', 'MLB1196', 'MLB1168', 'MLB264586', 'MLB1953'];

export type CatNode = { id: string; name: string; total?: number; parentId?: string; children?: string[] /* undefined = ainda não buscada */ };
type Cache = { builtAt: number; nodes: Record<string, CatNode> };

const nodes = new Map<string, CatNode>();
let builtAt = 0;
let warming: Promise<void> | null = null;
let loaded = false;

function loadFromDisk() {
  if (loaded) return; loaded = true;
  try {
    const c: Cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && c.nodes) { builtAt = c.builtAt || 0; for (const n of Object.values(c.nodes)) nodes.set(n.id, n); }
  } catch { /* sem cache ainda */ }
}
function saveToDisk() {
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify({ builtAt, nodes: Object.fromEntries(nodes) } satisfies Cache)); } catch (e: any) { console.warn('Categorias ML: não consegui gravar o cache:', e?.message); }
}

/** Busca uma categoria no ML e registra ela e as filhas (só o nome das filhas; as netas ficam para depois). */
async function fetchCategory(id: string): Promise<CatNode | null> {
  const r = await fetch(`${API}/categories/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
  if (r.status !== 200) return null;
  const d: any = await r.json().catch(() => null); if (!d?.id) return null;
  const pathFromRoot: any[] = Array.isArray(d.path_from_root) ? d.path_from_root : [];
  const parentId = pathFromRoot.length >= 2 ? String(pathFromRoot[pathFromRoot.length - 2].id) : undefined;
  const kids: any[] = Array.isArray(d.children_categories) ? d.children_categories : [];
  const node: CatNode = { id: String(d.id), name: String(d.name || d.id), total: Number(d.total_items_in_this_category) || undefined, parentId, children: kids.map(k => String(k.id)) };
  nodes.set(node.id, node);
  for (const k of kids) {
    const kid = nodes.get(String(k.id));
    if (kid) { kid.name = String(k.name || kid.name); kid.total = Number(k.total_items_in_this_category) || kid.total; kid.parentId = node.id; }
    else nodes.set(String(k.id), { id: String(k.id), name: String(k.name || k.id), total: Number(k.total_items_in_this_category) || undefined, parentId: node.id });
  }
  return node;
}

async function mapLimit<T>(list: T[], limit: number, fn: (x: T) => Promise<unknown>) {
  let i = 0; const workers = Array.from({ length: Math.min(limit, list.length) }, async () => { while (i < list.length) { const x = list[i++]; try { await fn(x); } catch { /* segue */ } } });
  await Promise.all(workers);
}

/** Garante que a categoria tem as filhas carregadas (busca só se ainda não tiver). */
async function ensureExpanded(id: string): Promise<CatNode | undefined> {
  const n = nodes.get(id);
  if (n && n.children) return n;
  return (await fetchCategory(id)) || n;
}

/** Monta raízes + primeiro nível (≈450 categorias) em segundo plano. Idempotente. */
export function warmUpCategories(): Promise<void> {
  loadFromDisk();
  if (warming) return warming;
  if (nodes.size > 100 && Date.now() - builtAt < CACHE_TTL_MS) return Promise.resolve();
  warming = (async () => {
    const t0 = Date.now();
    await mapLimit(ROOTS, CONCURRENCY, fetchCategory);
    const level1 = ROOTS.flatMap(r => nodes.get(r)?.children || []).filter(id => !nodes.get(id)?.children);
    await mapLimit(level1, CONCURRENCY, fetchCategory);
    builtAt = Date.now(); saveToDisk();
    console.log(`Categorias ML: ${nodes.size} categorias carregadas em ${Math.round((Date.now() - t0) / 1000)}s.`);
  })().catch(e => console.warn('Categorias ML: falha ao montar a árvore:', e?.message)).finally(() => { warming = null; });
  return warming;
}

export function categoriesReady() { loadFromDisk(); return nodes.size > 100; }

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Radical simples para casar singular/plural e variações: "infantil" -> "infant" casa "infantis"; "carro" -> "carr" casa "carros". */
const stem = (w: string) => w.length >= 7 ? w.slice(0, -2) : w.length >= 5 ? w.slice(0, -1) : w;

// Sinônimos comuns de quem fala "nicho" e não "categoria do ML".
const SYNONYMS: Record<string, string[]> = {
  infantil: ['crianca', 'bebe', 'kids', 'menino', 'menina', 'brinquedo'],
  crianca: ['infantil', 'kids', 'menino', 'menina'],
  carro: ['automotivo', 'veiculo', 'carros'],
  veiculo: ['automotivo', 'carro', 'moto'],
  automotivo: ['carro', 'veiculo'],
  moto: ['motocicleta', 'motociclista'],
  celular: ['smartphone', 'telefone'],
  computador: ['informatica', 'notebook', 'pc'],
  cozinha: ['culinaria', 'panela', 'utensilio'],
  casa: ['decoracao', 'moveis', 'lar'],
  academia: ['fitness', 'musculacao', 'treino'],
  fitness: ['academia', 'musculacao', 'esporte'],
  pet: ['cachorro', 'gato', 'animal', 'caes'],
  cachorro: ['cao', 'caes', 'pet'],
  beleza: ['maquiagem', 'cabelo', 'cuidado', 'perfume'],
  roupa: ['vestuario', 'moda', 'camiseta', 'calca'],
  moda: ['roupa', 'vestuario', 'calcado', 'bolsa'],
  ferramenta: ['furadeira', 'parafusadeira', 'oficina'],
  game: ['videogame', 'console', 'jogo'],
  jogo: ['game', 'videogame', 'tabuleiro'],
  pesca: ['pescaria', 'vara', 'molinete', 'isca'],
  camping: ['acampamento', 'barraca', 'trilha'],
  churrasco: ['churrasqueira', 'grelha', 'espeto'],
  jardim: ['jardinagem', 'planta', 'horta'],
  escritorio: ['papelaria', 'escolar', 'caderno'],
  festa: ['aniversario', 'lembrancinha'],
  saude: ['suplemento', 'vitamina', 'ortopedico', 'massagem'],
};

export type CatGroup = { id: string; name: string; total?: number; path: string[]; children: Array<{ id: string; name: string; total?: number }> };
export type CatSearch = { query: string; ready: boolean; groups: CatGroup[]; totalMatches: number };

function pathOf(id: string): string[] {
  const out: string[] = []; let cur = nodes.get(id); let guard = 0;
  while (cur && guard++ < 10) { out.unshift(cur.name); cur = cur.parentId ? nodes.get(cur.parentId) : undefined; }
  return out;
}

/** Categorias cujo nome (ou o caminho) casa com o nicho digitado, cada uma com suas subcategorias. */
export async function searchCategories(queryRaw: string, maxGroups = 40): Promise<CatSearch> {
  loadFromDisk();
  const ready = categoriesReady();
  if (!ready) warmUpCategories(); // começa a montar; esta busca usa o que já tiver
  const query = queryRaw.trim();
  const tokens = strip(query).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !['para', 'com', 'dos', 'das'].includes(w));
  const direct = tokens.map(stem);
  const viaSyn: string[] = [];
  for (const t of tokens) for (const s of (SYNONYMS[t] || SYNONYMS[stem(t)] || [])) viaSyn.push(stem(strip(s)));
  // Casa só no começo de uma palavra do nome e com terminação curta: "infant" casa "infantis", mas "carr" não casa "carregadores".
  const wordHit = (w: string, st: string) => w.startsWith(st) && (w.length - st.length) <= (st.length >= 5 ? 3 : st.length >= 4 ? 2 : 1);
  const score = (name: string) => { const ws = strip(name).split(/[^a-z0-9]+/).filter(Boolean); if (direct.some(st => ws.some(w => wordHit(w, st)))) return 2; if (viaSyn.some(st => ws.some(w => wordHit(w, st)))) return 1; return 0; };
  const adult = (id: string) => pathOf(id).some(n => strip(n) === 'adultos');
  const findMatches = () => [...nodes.values()].map(n => ({ n, s: score(n.name) })).filter(x => x.s > 0 && !adult(x.n.id));

  // 1) casa pelo nome em tudo que já está carregado
  let hits = findMatches();
  // 2) aprofunda as casadas (filhas das filhas), maiores primeiro — limitado para não estourar a API
  await mapLimit(hits.filter(x => !x.n.children).sort((a, b) => (b.n.total || 0) - (a.n.total || 0)).slice(0, 60), CONCURRENCY, x => ensureExpanded(x.n.id));
  hits = findMatches();
  const matched = hits.map(x => x.n); const scoreOf = new Map(hits.map(x => [x.n.id, x.s]));
  // 3) se a mãe casou, a filha aparece dentro dela; não repete como grupo. Acertos diretos vêm antes dos por sinônimo.
  const ids = new Set(matched.map(m => m.id));
  // Uma filha que casou e tem as próprias subcategorias (ex.: "Pesca" dentro de "Camping, Caça e Pesca") vira grupo também.
  const groups = matched.filter(m => !(m.parentId && ids.has(m.parentId) && !m.children?.length))
    .sort((a, b) => (scoreOf.get(b.id)! - scoreOf.get(a.id)!) || ((b.total || 0) - (a.total || 0)))
    .slice(0, maxGroups)
    .map((m): CatGroup => ({
      id: m.id, name: m.name, total: m.total, path: pathOf(m.id).slice(0, -1),
      children: (m.children || []).map(id => nodes.get(id)).filter((c): c is CatNode => !!c).sort((a, b) => (b.total || 0) - (a.total || 0)).map(c => ({ id: c.id, name: c.name, total: c.total }))
    }));
  return { query, ready, groups, totalMatches: matched.length };
}
