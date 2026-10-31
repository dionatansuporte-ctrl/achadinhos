import { prisma } from '../db';
import { TELEGRAM_AUTO } from '../integrations/telegram';
import { renderOffer, defaultOfferTemplate, offerCard } from './offer';
import { matchesRules } from './rules';
import { productCoupons, pickCoupon } from './coupons';
import { hasShopeeSearch, syncShopeeProducts, searchMarketplaceLabel, describeSearch } from './shopee-sync';
import { titleWords, titleHead, titleSimilarity, titleOverlap, TITLE_SIMILAR_MIN, KIND_SIMILAR_MIN } from './title-key';
import { roundCount } from './cleanup';

/**
 * Executa uma automação: escolhe produtos, monta a mensagem e coloca os envios na fila.
 * Usado pelo botão "Testar 1 envio" (perRun 1) e pelo agendador (perRun da agenda).
 *
 * Repetição (contando qualquer automação do usuário, por grupo):
 * - Mesmo anúncio (ID, externalId ou URL): só volta depois de `repeatAfterDays` dias (padrão 3; 0 = nunca).
 * - Mesmo modelo em outro anúncio ou variação (título igual ou quase igual: outra cor, loja, vendedor):
 *   só volta depois de 2 h e com preço diferente do último envio (pedido do usuário em 2026-10-31).
 * - Variedade: dois produtos do mesmo tipo (dois filamentos, duas centrais multimídia) não saem na mesma
 *   rodada nem em menos de 2 h, enquanto houver outra coisa para mandar. Não bloqueia: é só ordem.
 * Produtos que nunca saíram têm prioridade; os repetidos só completam a cota quando não há novidade,
 * e vão com os dados recém-importados da busca (preço, desconto, imagem atualizados).
 * Quando a busca da Shopee só devolve produtos já enviados, avança páginas até achar novos.
 */

export type ScheduleJson = {
  type?: 'daily' | 'interval';
  startTime?: string;   // "08:00"
  endTime?: string;     // "22:00"
  everyMinutes?: number;
  perRun?: number;      // produtos por disparo
  repeatAfterDays?: number; // dias até um produto poder repetir no mesmo grupo (0 = nunca)
  channelIds?: string[];
  time?: string;        // legado (type daily)
};

export type RunResult = { jobs: number; products: number; skipped: number; message: string };

const MAX_SHOPEE_PAGES = 5;
export const DEFAULT_REPEAT_AFTER_DAYS = 3;
/** Mesmo modelo em outro anúncio: espera isto e só volta com preço diferente. */
export const MODEL_REPEAT_MS = 2 * 3_600_000;
/** Variedade: produto do mesmo tipo de um enviado há menos disto vai para o fim da fila. */
export const KIND_WINDOW_MS = 2 * 3_600_000;

// Uma rodada por automação de cada vez: o "Testar 1 envio" manual junto com o agendador liam o histórico
// ao mesmo tempo e enfileiravam o mesmo produto duas vezes para o mesmo grupo.
const running = new Map<string, Promise<unknown>>();
export function runAutomation(automationId: string, opts: { source: 'manual' | 'scheduler'; perRun?: number }): Promise<RunResult> {
  const prev = running.get(automationId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => runAutomationNow(automationId, opts));
  running.set(automationId, next);
  next.finally(() => { if (running.get(automationId) === next) running.delete(automationId); }).catch(() => {});
  return next;
}

const priceOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
};
const samePrice = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;

/** Um envio já feito (ou na fila) para um grupo: palavras do título, quando, por quanto e de qual anúncio. */
type Sent = { words: string[]; head: string; key: string; t: number; price?: number; listing: string[] };
/** Palavras e primeira palavra de um título, para comparar tipo de produto. */
type Kind = { words: string[]; head: string };
const kindOf = (title: unknown): Kind => ({ words: titleWords(String(title || '')), head: titleHead(String(title || '')) });
/**
 * Mesmo tipo de produto: títulos que dividem boa parte das palavras, ou que começam pela mesma palavra
 * ("Filamento PLA Kosen" x "Filamento PETG Premium") e ainda têm algo mais em comum.
 */
const sameKind = (a: Kind, b: Kind) => {
  if (a.words.length < 2 || b.words.length < 2) return false;
  const ov = titleOverlap(a.words, b.words);
  return ov >= KIND_SIMILAR_MIN || (!!a.head && a.head === b.head && ov >= 0.25);
};

async function runAutomationNow(automationId: string, opts: { source: 'manual' | 'scheduler'; perRun?: number }): Promise<RunResult> {
  const a = await prisma.automation.findUnique({ where: { id: automationId }, include: { list: { include: { products: { include: { product: true } } } } } });
  if (!a) throw new Error('Automação não encontrada.');

  const schedule = (a.scheduleJson || {}) as ScheduleJson;
  const picked = Array.isArray(schedule.channelIds) ? schedule.channelIds : [];
  // Canal do Telegram marcado "automático" (configJson.allAutomations, padrão ao cadastrar pela tela Telegram) recebe
  // as ofertas de TODAS as automações, mesmo as que escolheram só alguns grupos (pedido do usuário em 2026-10-16).
  const channels = await prisma.channel.findMany({ where: { userId: a.userId, enabled: true, ...(picked.length ? { OR: [{ id: { in: picked } }, TELEGRAM_AUTO] } : {}) } });
  if (!channels.length) throw new Error(picked.length ? 'Os canais escolhidos nesta automação estão pausados ou foram excluídos.' : 'Cadastre ao menos um canal.');

  const repeatAfterDays = typeof schedule.repeatAfterDays === 'number' && schedule.repeatAfterDays >= 0 ? schedule.repeatAfterDays : DEFAULT_REPEAT_AFTER_DAYS;
  const repeatAfterMs = repeatAfterDays * 86_400_000;
  const now = Date.now();

  // Tudo que já saiu (ou está saindo) para cada grupo, de qualquer automação deste usuário,
  // com a data e o preço do último envio. Mesmo item reimportado com outro id (externalId/URL iguais) conta,
  // e o mesmo produto em outro anúncio (ID diferente, título igual ou quase igual) também.
  // Envios cujo produto foi excluído ainda contam pelo título guardado na mensagem.
  // Só o histórico que pode bloquear: na fila, ou criado dentro da janela de repetição. Com "nunca repetir"
  // (0 dias) precisa de tudo. Mínimo de 30 dias para "novos primeiro" ainda distinguir produto nunca
  // enviado de produto antigo. Evita carregar meses de envios a cada rodada.
  const historyMs = repeatAfterDays === 0 ? undefined : Math.max(repeatAfterMs, 30 * 86_400_000);
  const sentRows = await prisma.promotionJob.findMany({
    where: {
      channelId: { in: channels.map(c => c.id) }, status: { in: ['PENDING', 'PROCESSING', 'SENT'] },
      ...(historyMs ? { OR: [{ status: { in: ['PENDING', 'PROCESSING'] } }, { createdAt: { gte: new Date(now - historyMs) } }] } : {})
    },
    select: { productId: true, channelId: true, status: true, sentAt: true, createdAt: true, payloadJson: true, product: { select: { externalId: true, productUrl: true, title: true, price: true } } }
  });
  // chave anúncio+grupo → instante do último envio (Infinity = ainda na fila, nunca pode repetir agora)
  const lastSent = new Map<string, number>();
  const mark = (key: string, t: number) => { const cur = lastSent.get(key); if (cur === undefined || t > cur) lastSent.set(key, t); };
  // O "mesmo anúncio": id do produto, id no marketplace ou URL.
  const listingKeys = (p: any, channelId: string) => {
    const k: string[] = [];
    if (p.id) k.push(`p:${p.id}:${channelId}`);
    if (p.externalId) k.push(`x:${p.externalId}:${channelId}`);
    if (p.productUrl) k.push(`u:${p.productUrl}:${channelId}`);
    return k;
  };
  // Títulos já enviados por grupo, para pegar o mesmo modelo em outro anúncio e produtos do mesmo tipo.
  const titleHist = new Map<string, Sent[]>();
  const rememberSent = (p: any, channelId: string, t: number) => {
    const listing = listingKeys(p, channelId);
    for (const k of listing) mark(k, t);
    const words = titleWords(p.title);
    if (!words.length) return;
    const arr = titleHist.get(channelId) || [];
    arr.push({ words, head: titleHead(p.title), key: words.join(' '), t, price: priceOf(p.price), listing });
    titleHist.set(channelId, arr);
  };
  for (const r of sentRows) {
    const t = r.status === 'SENT' ? (r.sentAt || r.createdAt).getTime() : Infinity;
    const payload = (r.payloadJson || {}) as any;
    // Preço de quando saiu (gravado na fila desde 2026-10-31); envios antigos usam o preço atual do produto.
    const price = payload.price ?? r.product?.price;
    rememberSent({ id: r.productId, externalId: r.product?.externalId, productUrl: r.product?.productUrl, title: r.product?.title || payload.title, price }, r.channelId, t);
  }
  // Último envio do mesmo anúncio.
  const lastListingSend = (p: any, channelId: string) => {
    let t: number | undefined;
    for (const k of listingKeys(p, channelId)) {
      const v = lastSent.get(k); if (v !== undefined && (t === undefined || v > t)) t = v;
    }
    return t;
  };
  // Último envio do mesmo modelo em OUTRO anúncio ou variação: título igual (mesmas palavras) ou quase igual
  // (outra cor, voltagem, vendedor, loja). O próprio anúncio não entra: esse segue a regra dos dias.
  const lastModelSend = (p: any, channelId: string): Sent | undefined => {
    const words = titleWords(p.title);
    if (!words.length) return undefined;
    const key = words.join(' ');
    const mine = listingKeys(p, channelId);
    let best: Sent | undefined;
    for (const h of titleHist.get(channelId) || []) {
      if (h.listing.some(k => mine.includes(k))) continue;
      // Títulos curtos (menos de 3 palavras) só contam quando são iguais: comparar "quase igual" neles é arriscado.
      const same = h.key === key || (words.length >= 3 && h.words.length >= 3 && titleSimilarity(words, h.words) >= TITLE_SIMILAR_MIN);
      if (same && (!best || h.t > best.t)) best = h;
    }
    return best;
  };
  const lastSentAt = (p: any, channelId: string) => {
    const a = lastListingSend(p, channelId);
    const b = lastModelSend(p, channelId)?.t;
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };
  // Mesmo anúncio bloqueado: na fila, ou enviado há menos de repeatAfterDays (com 0 dias nunca repete).
  const blockedAt = (t: number | undefined) => {
    if (t === undefined) return false;
    if (!isFinite(t) || repeatAfterDays === 0) return true;
    return now - t < repeatAfterMs;
  };
  const blockedListing = (p: any, channelId: string) => blockedAt(lastListingSend(p, channelId));
  // Mesmo modelo em outro anúncio: espera 2 h e só volta com preço diferente do último envio.
  const blockedModel = (p: any, channelId: string) => {
    const h = lastModelSend(p, channelId);
    if (!h) return false;
    if (!isFinite(h.t) || now - h.t < MODEL_REPEAT_MS) return true;
    return samePrice(h.price, priceOf(p.price));
  };
  const alreadySent = (p: any, channelId: string) => blockedListing(p, channelId) || blockedModel(p, channelId);
  const pendingChannels = (p: any) => channels.filter(c => !alreadySent(p, c.id));
  // Só a regra do modelo bloqueou? Então é "o mesmo produto em outro anúncio".
  const blockedOnlyByModel = (p: any) => channels.some(c => !blockedListing(p, c.id) && blockedModel(p, c.id));
  // Já saiu para todos os grupos liberados alguma vez? Então é repetição, não novidade.
  const isRepeat = (p: any) => pendingChannels(p).every(c => lastSentAt(p, c.id) !== undefined);
  const oldestSend = (p: any) => Math.min(...pendingChannels(p).map(c => lastSentAt(p, c.id) ?? 0));

  // Variedade: produto "do mesmo tipo" de um que saiu há menos de 2 h (ou já escolhido nesta rodada) para os grupos
  // desta automação vai para o fim da fila. Olha só os grupos escolhidos na automação: o canal automático do
  // Telegram recebe de todas as automações e deixaria tudo "repetido".
  const varietyChannels = picked.length ? channels.filter(c => picked.includes(c.id)) : channels;
  const chosenKinds = new Map<string, Kind[]>();
  const sameKindRecently = (k: Kind, channelId: string) => {
    if ((chosenKinds.get(channelId) || []).some(c => sameKind(k, c))) return true;
    return (titleHist.get(channelId) || []).some(h => (!isFinite(h.t) || now - h.t < KIND_WINDOW_MS) && sameKind(k, h));
  };
  let heldForVariety = 0; // quantos ficaram para depois por serem do mesmo tipo
  let fillers = 0;        // quantos entraram mesmo assim, por faltar variedade
  const pickVaried = (list: any[], n: number) => {
    const out: any[] = [];
    const rest: any[] = [];
    for (const p of list) {
      if (out.length >= n) break;
      const k = kindOf(p.title);
      if (varietyChannels.some(c => sameKindRecently(k, c.id))) { rest.push(p); continue; }
      out.push(p);
      for (const c of varietyChannels) chosenKinds.set(c.id, [...(chosenKinds.get(c.id) || []), k]);
    }
    const extra = rest.slice(0, n - out.length);
    fillers += extra.length;
    heldForVariety += rest.length - extra.length;
    return [...out, ...extra];
  };

  const rules = (a.rulesJson || {}) as any;
  const perRun = opts.perRun ?? (opts.source === 'scheduler' ? (schedule.perRun || 1) : undefined);
  const wanted = perRun ?? Number.MAX_SAFE_INTEGER;

  // Candidatos: produtos que passam nas regras e ainda têm ao menos um grupo liberado.
  // Novos (nunca enviados) primeiro; repetidos só completam a cota, do mais antigo para o mais recente.
  const fresh_: any[] = [];
  const repeats: any[] = [];
  const recent: any[] = []; // bloqueados em todos os grupos: último recurso para não ficar sem envio
  let skipped = 0;
  let skippedModel = 0; // dos pulados, quantos eram o mesmo modelo em outro anúncio
  const consider = (p: any) => {
    if (!matchesRules(p, rules)) return;
    if (!pendingChannels(p).length) { skipped++; if (blockedOnlyByModel(p)) skippedModel++; recent.push(p); return; }
    (isRepeat(p) ? repeats : fresh_).push(p);
  };
  const modelNote = () => skippedModel ? ` (${skippedModel} do mesmo modelo em outro anúncio: menos de 2 h ou mesmo preço)` : '';
  if (hasShopeeSearch(rules)) {
    const seen = new Set<string>();
    // O desconto mínimo das regras vai junto, para o Mercado Livre filtrar já na API.
    const minDiscount = (rules as any).minDiscount;
    // Rodízio de termos: o nº de rodadas anteriores desta automação diz qual bloco de termos usar agora,
    // para que todos os termos da lista apareçam ao longo do dia, não só os primeiros.
    // roundCount soma as rodadas que a limpeza de 5 em 5 dias já apagou (linha CURSOR), para o rodízio não voltar ao começo.
    const keywordCursor = await roundCount(a.id);
    const rule = { ...rules.shopeeSearch, minDiscount: typeof minDiscount === 'number' ? minDiscount : undefined, keywordCursor };
    for (let page = 1; page <= MAX_SHOPEE_PAGES && fresh_.length < wanted; page++) {
      let found: any[];
      try { found = await syncShopeeProducts(a.userId, rule, a.listId, page); }
      catch (e: any) {
        await prisma.automationLog.create({ data: { automationId: a.id, action: 'SEARCH', status: 'ERROR', message: `${searchMarketplaceLabel(rule)}: ${e.message}` } });
        throw e;
      }
      if (!found.length) break;
      const fresh = found.filter(p => !seen.has(p.id));
      fresh.forEach(p => seen.add(p.id));
      if (!fresh.length) break; // a API repetiu a página: não há mais novidade
      fresh.forEach(consider);
    }
    await prisma.automationLog.create({ data: { automationId: a.id, action: 'SEARCH', status: 'OK', message: `${searchMarketplaceLabel(rule)}: ${fresh_.length} produto(s) novos${repeats.length ? ` + ${repeats.length} liberado(s) para repetir` : ''} para "${describeSearch(rule)}"${skipped ? `, ${skipped} já enviados ignorados${modelNote()}` : ''}.` } });
  } else {
    const products = a.list?.products.map(x => x.product).filter(p => p.active)
      || await prisma.product.findMany({ where: { account: { userId: a.userId }, active: true }, orderBy: { createdAt: 'desc' } });
    products.forEach(consider);
  }

  repeats.sort((x, y) => oldestSend(x) - oldestSend(y));
  // Novos primeiro, variando o tipo de produto; repetidos só completam a cota.
  const chosen = pickVaried(fresh_, wanted);
  if (chosen.length < wanted) chosen.push(...pickVaried(repeats, wanted - chosen.length));
  // Nada novo nem liberado para repetir: em vez de ficar em silêncio, reenvia o que saiu há mais tempo
  // (só para grupos onde ele não está na fila). Com "nunca repetir" (0 dias) continua quieto.
  const forced = new Set<any>();
  const sentChannels = (p: any) => channels.filter(c => isFinite(lastSentAt(p, c.id) ?? Infinity));
  if (!chosen.length && repeatAfterDays > 0) {
    const lastAny = (p: any) => Math.max(...sentChannels(p).map(c => lastSentAt(p, c.id)!));
    recent.filter(p => sentChannels(p).length).sort((x, y) => lastAny(x) - lastAny(y))
      .slice(0, perRun ?? 1).forEach(p => { forced.add(p); chosen.push(p); });
  }
  const repeated = chosen.filter(p => isRepeat(p)).length;
  // Cupons cadastrados marcados "também nas mensagens de produto"; o cupom próprio do produto tem prioridade.
  const coupons = chosen.length ? await productCoupons(a.userId) : [];
  let jobs = 0;
  // Formato "card" (2026-10-28): texto + cartão de link com a foto embutida (aparece no grupo sem baixar).
  const asCard = rules.messageFormat === 'card';
  for (const p of chosen) {
    const offer = {
      title: p.title,
      price: priceOf(p.price),
      oldPrice: priceOf(p.oldPrice),
      discountPercent: p.discountPercent || undefined,
      couponText: p.couponText || pickCoupon(coupons, p),
      affiliateUrl: p.affiliateUrl,
      marketplace: p.marketplace
    };
    const text = renderOffer(a.template || defaultOfferTemplate(), offer);
    const card = asCard ? offerCard(offer, p.imageUrl) : undefined;
    for (const c of forced.has(p) ? sentChannels(p) : pendingChannels(p)) {
      // `price` fica guardado para a regra "mesmo modelo só volta com preço diferente".
      const job = await prisma.promotionJob.create({ data: { automationId: a.id, productId: p.id, channelId: c.id, scheduledAt: new Date(), payloadJson: { title: p.title, text, affiliateUrl: p.affiliateUrl, imageUrl: p.imageUrl, price: offer.price ?? null, ...(card ? { card } : {}) } } });
      rememberSent(p, c.id, Infinity); // evita mandar o "mesmo" produto de novo nesta rodada
      jobs++;
    }
  }

  const repeatNote = repeatAfterDays ? `há menos de ${repeatAfterDays} dia(s)` : 'antes (repetição desligada)';
  const varietyNote = heldForVariety ? ` ${heldForVariety} produto(s) do mesmo tipo de algo enviado há menos de 2 h ficaram para depois.` : '';
  const fillerNote = fillers ? ` ${fillers} produto(s) do mesmo tipo de algo recente saíram mesmo assim, por faltar variedade.` : '';
  const message = jobs && forced.size
    ? `Nada novo na busca: para não ficar sem envio, ${forced.size} produto(s) enviado(s) há mais tempo saíram de novo, com dados atualizados → ${jobs} envio(s).`
    : jobs
    ? `${chosen.length} produto(s) → ${jobs} envio(s) em ${channels.length} grupo(s).${repeated ?` ${repeated} repetido(s) após ${repeatAfterDays} dia(s), com dados atualizados.` : ''}${skipped ? ` ${skipped} produto(s) enviados ${repeatNote} foram pulados${modelNote()}.` : ''}${varietyNote}${fillerNote}`
    : skipped
      ? `Nada novo: todos os ${skipped} produto(s) encontrados já foram enviados ${repeatNote} para esses grupos${modelNote()}.`
      : 'Nenhum produto atende às regras desta automação.';
  await prisma.automationLog.create({ data: { automationId: a.id, action: opts.source === 'scheduler' ? 'RUN' : 'GENERATE_JOBS', status: 'OK', message } });
  return { jobs, products: chosen.length, skipped, message };
}
