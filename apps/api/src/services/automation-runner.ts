import { prisma } from '../db';
import { promotionQueue } from '../queue';
import { renderOffer, defaultOfferTemplate } from './offer';
import { matchesRules } from './rules';
import { productCoupons, pickCoupon } from './coupons';
import { hasShopeeSearch, syncShopeeProducts, marketplaceLabel, describeSearch } from './shopee-sync';

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
  // com a data do último envio. Mesmo item reimportado com outro id (externalId/URL iguais) conta.
  const sentRows = await prisma.promotionJob.findMany({
    where: { channelId: { in: channels.map(c => c.id) }, productId: { not: null }, status: { in: ['PENDING', 'PROCESSING', 'SENT'] } },
    select: { productId: true, channelId: true, status: true, sentAt: true, createdAt: true, product: { select: { externalId: true, productUrl: true } } }
  });
  // chave produto+grupo → instante do último envio (Infinity = ainda na fila, nunca pode repetir agora)
  const lastSent = new Map<string, number>();
  const mark = (key: string, t: number) => { const cur = lastSent.get(key); if (cur === undefined || t > cur) lastSent.set(key, t); };
  const keysOf = (p: any, channelId: string) => {
    const k = [`p:${p.id}:${channelId}`];
    if (p.externalId) k.push(`x:${p.externalId}:${channelId}`);
    if (p.productUrl) k.push(`u:${p.productUrl}:${channelId}`);
    return k;
  };
  for (const r of sentRows) {
    const t = r.status === 'SENT' ? (r.sentAt || r.createdAt).getTime() : Infinity;
    for (const k of keysOf({ id: r.productId, externalId: r.product?.externalId, productUrl: r.product?.productUrl }, r.channelId)) mark(k, t);
  }
  const lastSentAt = (p: any, channelId: string) => {
    let t: number | undefined;
    for (const k of keysOf(p, channelId)) { const v = lastSent.get(k); if (v !== undefined && (t === undefined || v > t)) t = v; }
    return t;
  };
  // Bloqueado: na fila, ou enviado há menos de repeatAfterDays (com 0 dias nunca repete).
  const alreadySent = (p: any, channelId: string) => {
    const t = lastSentAt(p, channelId);
    if (t === undefined) return false;
    if (!isFinite(t) || repeatAfterDays === 0) return true;
    return now - t < repeatAfterMs;
  };
  const pendingChannels = (p: any) => channels.filter(c => !alreadySent(p, c.id));
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
  const consider = (p: any) => {
    if (!matchesRules(p, rules)) return;
    if (!pendingChannels(p).length) { skipped++; return; }
    (isRepeat(p) ? repeats : fresh_).push(p);
  };
  if (hasShopeeSearch(rules)) {
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_SHOPEE_PAGES && fresh_.length < wanted; page++) {
      let found: any[];
      // O desconto mínimo das regras vai junto, para o Mercado Livre filtrar já na API.
      const minDiscount = (rules as any).minDiscount;
      const rule = { ...rules.shopeeSearch, minDiscount: typeof minDiscount === 'number' ? minDiscount : undefined };
      try { found = await syncShopeeProducts(a.userId, rule, a.listId, page); }
      catch (e: any) {
        await prisma.automationLog.create({ data: { automationId: a.id, action: 'SEARCH', status: 'ERROR', message: `${marketplaceLabel(rule.marketplace)}: ${e.message}` } });
        throw e;
      }
      if (!found.length) break;
      const fresh = found.filter(p => !seen.has(p.id));
      fresh.forEach(p => seen.add(p.id));
      if (!fresh.length) break; // a API repetiu a página: não há mais novidade
      fresh.forEach(consider);
    }
    await prisma.automationLog.create({ data: { automationId: a.id, action: 'SEARCH', status: 'OK', message: `${marketplaceLabel(rules.shopeeSearch.marketplace)}: ${fresh_.length} produto(s) novos${repeats.length ? ` + ${repeats.length} liberado(s) para repetir` : ''} para "${describeSearch(rules.shopeeSearch)}"${skipped ? `, ${skipped} já enviados ignorados` : ''}.` } });
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
      for (const k of keysOf(p, c.id)) mark(k, Infinity);
      jobs++;
    }
  }

  const repeatNote = repeatAfterDays ? `há menos de ${repeatAfterDays} dia(s)` : 'antes (repetição desligada)';
  const message = jobs
    ? `${chosen.length} produto(s) → ${jobs} envio(s) em ${channels.length} grupo(s).${repeated ? ` ${repeated} repetido(s) após ${repeatAfterDays} dia(s), com dados atualizados.` : ''}${skipped ? ` ${skipped} produto(s) enviados ${repeatNote} foram pulados.` : ''}`
    : skipped
      ? `Nada novo: todos os ${skipped} produto(s) encontrados já foram enviados ${repeatNote} para esses grupos.`
      : 'Nenhum produto atende às regras desta automação.';
  await prisma.automationLog.create({ data: { automationId: a.id, action: opts.source === 'scheduler' ? 'RUN' : 'GENERATE_JOBS', status: 'OK', message } });
  return { jobs, products: chosen.length, skipped, message };
}
