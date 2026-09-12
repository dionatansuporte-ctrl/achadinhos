import { prisma } from '../db';
import { promotionQueue } from '../queue';
import { renderOffer, defaultOfferTemplate } from './offer';
import { matchesRules } from './rules';
import { productCoupons, pickCoupon } from './coupons';
import { hasShopeeSearch, syncShopeeProducts, searchMarketplaceLabel, describeSearch } from './shopee-sync';
import { titleKey, titleWords, titleSimilarity, TITLE_SIMILAR_MIN } from './title-key';

/**
 * Executa uma automação: escolhe produtos, monta a mensagem e coloca os envios na fila.
 * Usado pelo botão "Testar 1 envio" (perRun 1) e pelo agendador (perRun da agenda).
 *
 * Repetição: um produto só volta para o mesmo grupo depois de `repeatAfterDays` dias
 * (padrão 3; 0 = nunca repete), contando qualquer automação do usuário. Produtos que
 * nunca saíram têm prioridade; os repetidos só completam a cota quando não há novidade,
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

export async function runAutomation(automationId: string, opts: { source: 'manual' | 'scheduler'; perRun?: number }): Promise<RunResult> {
  const a = await prisma.automation.findUnique({ where: { id: automationId }, include: { list: { include: { products: { include: { product: true } } } } } });
  if (!a) throw new Error('Automação não encontrada.');

  const schedule = (a.scheduleJson || {}) as ScheduleJson;
  const picked = Array.isArray(schedule.channelIds) ? schedule.channelIds : [];
  const channels = await prisma.channel.findMany({ where: { userId: a.userId, enabled: true, ...(picked.length ? { id: { in: picked } } : {}) } });
  if (!channels.length) throw new Error(picked.length ? 'Os canais escolhidos nesta automação estão pausados ou foram excluídos.' : 'Cadastre ao menos um canal.');

  const repeatAfterDays = typeof schedule.repeatAfterDays === 'number' && schedule.repeatAfterDays >= 0 ? schedule.repeatAfterDays : DEFAULT_REPEAT_AFTER_DAYS;
  const repeatAfterMs = repeatAfterDays * 86_400_000;
  const now = Date.now();

  // Tudo que já saiu (ou está saindo) para cada grupo, de qualquer automação deste usuário,
  // com a data do último envio. Mesmo item reimportado com outro id (externalId/URL iguais) conta,
  // e o mesmo produto em outro anúncio (ID diferente, título igual ou quase igual) também.
  // Envios cujo produto foi excluído ainda contam pelo título guardado na mensagem.
  const sentRows = await prisma.promotionJob.findMany({
    where: { channelId: { in: channels.map(c => c.id) }, status: { in: ['PENDING', 'PROCESSING', 'SENT'] } },
    select: { productId: true, channelId: true, status: true, sentAt: true, createdAt: true, payloadJson: true, product: { select: { externalId: true, productUrl: true, title: true } } }
  });
  // chave produto+grupo → instante do último envio (Infinity = ainda na fila, nunca pode repetir agora)
  const lastSent = new Map<string, number>();
  const mark = (key: string, t: number) => { const cur = lastSent.get(key); if (cur === undefined || t > cur) lastSent.set(key, t); };
  const keysOf = (p: any, channelId: string) => {
    const k: string[] = [];
    if (p.id) k.push(`p:${p.id}:${channelId}`);
    if (p.externalId) k.push(`x:${p.externalId}:${channelId}`);
    if (p.productUrl) k.push(`u:${p.productUrl}:${channelId}`);
    const tk = titleKey(p.title);
    if (tk) k.push(`t:${tk}:${channelId}`);
    return k;
  };
  // Títulos já enviados por grupo, para pegar "quase igual" (outra cor, voltagem, vendedor).
  const titleHist = new Map<string, { words: string[]; t: number }[]>();
  const rememberTitle = (title: string | undefined, channelId: string, t: number) => {
    const words = titleWords(title);
    if (words.length < 3) return; // curto demais para comparar com segurança (ex.: "Cupons Shopee")
    const arr = titleHist.get(channelId) || [];
    arr.push({ words, t });
    titleHist.set(channelId, arr);
  };
  for (const r of sentRows) {
    const t = r.status === 'SENT' ? (r.sentAt || r.createdAt).getTime() : Infinity;
    const title = r.product?.title || (r.payloadJson as any)?.title;
    for (const k of keysOf({ id: r.productId, externalId: r.product?.externalId, productUrl: r.product?.productUrl, title }, r.channelId)) mark(k, t);
    rememberTitle(title, r.channelId, t);
  }
  const rememberSent = (p: any, channelId: string, t: number) => {
    for (const k of keysOf(p, channelId)) mark(k, t);
    rememberTitle(p.title, channelId, t);
  };
  // Último envio pelo id/URL/título exato do produto.
  const lastSentByKey = (p: any, channelId: string, includeTitle = true) => {
    let t: number | undefined;
    for (const k of keysOf(p, channelId)) {
      if (!includeTitle && k.startsWith('t:')) continue;
      const v = lastSent.get(k); if (v !== undefined && (t === undefined || v > t)) t = v;
    }
    return t;
  };
  // Último envio de um produto com título quase igual.
  const lastSentBySimilarTitle = (p: any, channelId: string) => {
    const words = titleWords(p.title);
    if (words.length < 3) return undefined;
    let t: number | undefined;
    for (const h of titleHist.get(channelId) || []) {
      if (titleSimilarity(words, h.words) >= TITLE_SIMILAR_MIN && (t === undefined || h.t > t)) t = h.t;
    }
    return t;
  };
  const lastSentAt = (p: any, channelId: string) => {
    const a = lastSentByKey(p, channelId);
    const b = lastSentBySimilarTitle(p, channelId);
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.max(a, b);
  };
  // Bloqueado: na fila, ou enviado há menos de repeatAfterDays (com 0 dias nunca repete).
  const blockedAt = (t: number | undefined) => {
    if (t === undefined) return false;
    if (!isFinite(t) || repeatAfterDays === 0) return true;
    return now - t < repeatAfterMs;
  };
  const alreadySent = (p: any, channelId: string) => blockedAt(lastSentAt(p, channelId));
  const pendingChannels = (p: any) => channels.filter(c => !alreadySent(p, c.id));
  // Só o título (quase) igual bloqueou? Então é "o mesmo produto em outro anúncio".
  const blockedOnlyByTitle = (p: any) => channels.some(c => !blockedAt(lastSentByKey(p, c.id, false)) && blockedAt(lastSentAt(p, c.id)));
  // Já saiu para todos os grupos liberados alguma vez? Então é repetição, não novidade.
  const isRepeat = (p: any) => pendingChannels(p).every(c => lastSentAt(p, c.id) !== undefined);
  const oldestSend = (p: any) => Math.min(...pendingChannels(p).map(c => lastSentAt(p, c.id) ?? 0));

  const rules = (a.rulesJson || {}) as any;
  const perRun = opts.perRun ?? (opts.source === 'scheduler' ? (schedule.perRun || 1) : undefined);
  const wanted = perRun ?? Number.MAX_SAFE_INTEGER;

  // Candidatos: produtos que passam nas regras e ainda têm ao menos um grupo liberado.
  // Novos (nunca enviados) primeiro; repetidos só completam a cota, do mais antigo para o mais recente.
  const fresh_: any[] = [];
  const repeats: any[] = [];
  let skipped = 0;
  let skippedTitle = 0; // dos pulados, quantos eram o mesmo produto em outro anúncio (título igual)
  const consider = (p: any) => {
    if (!matchesRules(p, rules)) return;
    if (!pendingChannels(p).length) { skipped++; if (blockedOnlyByTitle(p)) skippedTitle++; return; }
    (isRepeat(p) ? repeats : fresh_).push(p);
  };
  const titleNote = () => skippedTitle ? ` (${skippedTitle} por título igual em outro anúncio)` : '';
  if (hasShopeeSearch(rules)) {
    const seen = new Set<string>();
    // O desconto mínimo das regras vai junto, para o Mercado Livre filtrar já na API.
    const minDiscount = (rules as any).minDiscount;
    // Rodízio de termos: o nº de rodadas anteriores desta automação diz qual bloco de termos usar agora,
    // para que todos os termos da lista apareçam ao longo do dia, não só os primeiros.
    const keywordCursor = await prisma.automationLog.count({ where: { automationId: a.id, action: { in: ['RUN', 'GENERATE_JOBS'] } } });
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
    await prisma.automationLog.create({ data: { automationId: a.id, action: 'SEARCH', status: 'OK', message: `${searchMarketplaceLabel(rule)}: ${fresh_.length} produto(s) novos${repeats.length ? ` + ${repeats.length} liberado(s) para repetir` : ''} para "${describeSearch(rule)}"${skipped ? `, ${skipped} já enviados ignorados${titleNote()}` : ''}.` } });
  } else {
    const products = a.list?.products.map(x => x.product).filter(p => p.active)
      || await prisma.product.findMany({ where: { account: { userId: a.userId }, active: true }, orderBy: { createdAt: 'desc' } });
    products.forEach(consider);
  }

  repeats.sort((x, y) => oldestSend(x) - oldestSend(y));
  const candidates = [...fresh_, ...repeats];
  const chosen = candidates.slice(0, wanted);
  const repeated = chosen.filter(p => isRepeat(p)).length;
  // Cupons cadastrados marcados "também nas mensagens de produto"; o cupom próprio do produto tem prioridade.
  const coupons = chosen.length ? await productCoupons(a.userId) : [];
  let jobs = 0;
  for (const p of chosen) {
    const text = renderOffer(a.template || defaultOfferTemplate(), {
      title: p.title,
      price: p.price ? Number(p.price) : undefined,
      oldPrice: p.oldPrice ? Number(p.oldPrice) : undefined,
      discountPercent: p.discountPercent || undefined,
      couponText: p.couponText || pickCoupon(coupons, p),
      affiliateUrl: p.affiliateUrl
    });
    for (const c of pendingChannels(p)) {
      const job = await prisma.promotionJob.create({ data: { automationId: a.id, productId: p.id, channelId: c.id, scheduledAt: new Date(), payloadJson: { title: p.title, text, affiliateUrl: p.affiliateUrl, imageUrl: p.imageUrl } } });
      await promotionQueue.add('send-promotion', { jobId: job.id }, { attempts: 3, removeOnComplete: 100, removeOnFail: 100 });
      rememberSent(p, c.id, Infinity); // evita mandar o "mesmo" produto de novo nesta rodada
      jobs++;
    }
  }

  const repeatNote = repeatAfterDays ? `há menos de ${repeatAfterDays} dia(s)` : 'antes (repetição desligada)';
  const message = jobs
    ? `${chosen.length} produto(s) → ${jobs} envio(s) em ${channels.length} grupo(s).${repeated ? ` ${repeated} repetido(s) após ${repeatAfterDays} dia(s), com dados atualizados.` : ''}${skipped ? ` ${skipped} produto(s) enviados ${repeatNote} foram pulados${titleNote()}.` : ''}`
    : skipped
      ? `Nada novo: todos os ${skipped} produto(s) encontrados já foram enviados ${repeatNote} para esses grupos${titleNote()}.`
      : 'Nenhum produto atende às regras desta automação.';
  await prisma.automationLog.create({ data: { automationId: a.id, action: opts.source === 'scheduler' ? 'RUN' : 'GENERATE_JOBS', status: 'OK', message } });
  return { jobs, products: chosen.length, skipped, message };
}
