import { prisma } from '../db';
import { anyWaConnected, groupMemberInfo, groupMembersForGuard, isOurNumber, listGroups, onGroupMembers, removeGroupMembers, type WaGroupMemberInfo } from '../integrations/whatsapp-web';

/**
 * Proteção dos grupos (pedido do usuário em 2026-10-14): tira sozinho de cada grupo quem entra com número estrangeiro
 * (DDI fora da lista permitida, por padrão só o 55) ou com número/prefixo bloqueado (ex.: "62" e "63", de onde vinham
 * os contatos de robô que o usuário removia na mão: +62 858-3467-6571, +63 975 291 1836).
 *
 * Três caminhos:
 *   - na hora: cada entrada num grupo (aviso do WhatsApp) é conferida e, se for o caso, a pessoa é removida;
 *   - varredura manual: a tela lista quem deveria sair (de um grupo ou de todos) e remove quando o usuário manda;
 *   - varredura automática (opcional, a cada 6 h): pega quem entrou enquanto o sistema estava desligado.
 * Só funciona nos grupos em que um número nosso é administrador. Administradores e os nossos números nunca saem.
 * Cada remoção (ou tentativa) fica em GroupBlock, para o quadro "Removidos pelo robô".
 */

export type GuardConfig = { enabled: boolean; sweep: boolean; allowedDdi: string[]; blocked: string[] };
export type BlockReason = 'FOREIGN' | 'PREFIX' | 'NUMBER';
export const REASON_LABEL: Record<BlockReason, string> = { FOREIGN: 'número estrangeiro', PREFIX: 'prefixo bloqueado', NUMBER: 'número bloqueado' };

const DEFAULT: GuardConfig = { enabled: true, sweep: false, allowedDdi: ['55'], blocked: [] };
const digits = (s: unknown) => String(s ?? '').replace(/[^0-9]/g, '');
const asList = (v: unknown, fallback: string[]) => Array.isArray(v) ? v.map(digits).filter(Boolean) : fallback;
const SWEEP_EVERY = 6 * 60 * 60_000;

export async function getGuardConfig(): Promise<GuardConfig> {
  const row = await prisma.groupGuard.findUnique({ where: { id: 'main' } });
  if (!row) return { ...DEFAULT };
  return { enabled: row.enabled, sweep: row.sweep, allowedDdi: asList(row.allowedDdi, DEFAULT.allowedDdi), blocked: asList(row.blocked, []) };
}

export async function saveGuardConfig(c: GuardConfig): Promise<GuardConfig> {
  // DDI tem de 1 a 3 dígitos; bloqueado pode ser prefixo ou número inteiro (até 15 dígitos, o máximo de um telefone).
  const allowedDdi = [...new Set(c.allowedDdi.map(digits).filter(x => x.length >= 1 && x.length <= 3))];
  const blocked = [...new Set(c.blocked.map(digits).filter(x => x.length >= 1 && x.length <= 15))];
  if (!allowedDdi.length) throw new Error('Informe pelo menos um DDI permitido (ex.: 55 para o Brasil), senão todo mundo seria removido.');
  const data = { enabled: !!c.enabled, sweep: !!c.sweep, allowedDdi, blocked };
  await prisma.groupGuard.upsert({ where: { id: 'main' }, create: { id: 'main', ...data }, update: data });
  return getGuardConfig();
}

/** Por que este telefone deve ficar fora (null = pode ficar). Lista de bloqueados vale antes do DDI permitido. */
export function blockReason(phone: string, c: GuardConfig): BlockReason | null {
  const p = digits(phone);
  if (!p) return null;
  if (c.blocked.includes(p)) return 'NUMBER';
  if (c.blocked.some(b => b.length < p.length && p.startsWith(b))) return 'PREFIX';
  if (!c.allowedDdi.some(d => p.startsWith(d))) return 'FOREIGN';
  return null;
}

/** Motivo para tirar este membro do grupo (null = fica). Nossos números, administradores e quem não tem telefone visível ficam. */
function candidate(m: WaGroupMemberInfo, c: GuardConfig): BlockReason | null {
  if (m.mine || m.admin || !m.phone) return null;
  return blockReason(m.phone, c);
}

export type BlockItem = { member: string; phone: string; reason: BlockReason };
export type BlockOutcome = BlockItem & { ok: boolean; error?: string };

/** Remove os membros do grupo e registra cada resultado. Erro geral (ninguém é administrador etc.) vale para todos. */
async function removeAndLog(groupId: string, groupName: string | null, items: BlockItem[]): Promise<BlockOutcome[]> {
  if (!items.length) return [];
  let results: { member: string; ok: boolean; error?: string }[];
  try { results = await removeGroupMembers(groupId, items.map(i => i.member)); }
  catch (e: any) { results = items.map(i => ({ member: i.member, ok: false, error: e?.message || String(e) })); }
  const out = items.map(i => { const r = results.find(x => x.member === i.member); return { ...i, ok: !!r?.ok, error: r?.error }; });
  await prisma.groupBlock.createMany({ data: out.map(o => ({ groupId, groupName, member: o.phone, reason: o.reason, ok: o.ok, error: o.error || null })) });
  for (const o of out) console.log(`[proteção] ${o.ok ? 'removeu' : 'não conseguiu remover'} +${o.phone} do grupo ${groupName || groupId} (${REASON_LABEL[o.reason]})${o.error ? `: ${o.error}` : ''}`);
  return out;
}

// O mesmo aviso de entrada chega por cada número nosso que está no grupo: trata uma vez só.
const handled = new Map<string, number>();

export function startGroupGuard() {
  onGroupMembers(async m => {
    if (m.kind !== 'LINK' && m.kind !== 'ADDED') return;
    // Aviso velho (sincronização ao reconectar): a varredura cuida disso, aqui só o que acabou de acontecer.
    if (Date.now() - m.at.getTime() > 60 * 60_000) return;
    const key = `${m.groupId}|${m.member}`;
    const last = handled.get(key);
    if (last && Date.now() - last < 2 * 60_000) return;
    handled.set(key, Date.now());
    const c = await getGuardConfig();
    if (!c.enabled || isOurNumber(m.member)) return;
    let reason: BlockReason | null = null;
    let phone = m.member.endsWith('@s.whatsapp.net') ? digits(m.member.split('@')[0]) : '';
    try {
      const info = await groupMemberInfo(m.groupId, m.member);
      if (info) { reason = candidate(info, c); phone = info.phone || phone; }
      else if (phone) reason = blockReason(phone, c); // ainda não aparece na lista: decide pelo telefone do aviso
    } catch (e: any) {
      if (!phone) { console.warn(`[proteção] não consegui conferir quem entrou em ${m.groupName || m.groupId}: ${e?.message || e}`); return; }
      reason = blockReason(phone, c);
    }
    if (!reason || !phone) return;
    await removeAndLog(m.groupId, m.groupName, [{ member: m.member, phone, reason }]);
  });
  setInterval(() => { const cut = Date.now() - 10 * 60_000; for (const [k, t] of handled) if (t < cut) handled.delete(k); }, 10 * 60_000).unref();

  // Varredura automática: a cada 6 h, se estiver ligada e houver número conectado.
  setInterval(async () => {
    try {
      const c = await getGuardConfig();
      if (!c.enabled || !c.sweep || !anyWaConnected()) return;
      const r = await scanGroups(undefined, true);
      if (r.removed.length) console.log(`[proteção] varredura automática: ${r.removed.filter(x => x.ok).length} removido(s) de ${r.scanned} grupo(s).`);
    } catch (e: any) { console.warn(`[proteção] varredura automática falhou: ${e?.message || e}`); }
  }, SWEEP_EVERY).unref();
}

export type ScanHit = { groupId: string; groupName: string; member: string; phone: string; name: string | null; reason: BlockReason; admin: boolean };
export type ScanResult = { scanned: number; hits: ScanHit[]; errors: { groupId: string; groupName: string; error: string }[]; removed: (ScanHit & { ok: boolean; error?: string })[] };

/** Lista quem deveria sair de um grupo (ou de todos). remove=true já remove, nos grupos em que somos administradores. */
export async function scanGroups(groupId?: string, remove = false): Promise<ScanResult> {
  const c = await getGuardConfig();
  const groups: { id: string; name: string }[] = groupId ? [{ id: groupId, name: groupId }] : await listGroups();
  const out: ScanResult = { scanned: 0, hits: [], errors: [], removed: [] };
  for (const [i, g] of groups.entries()) {
    if (i) await new Promise(r => setTimeout(r, 300 + Math.random() * 400)); // uma folga entre grupos
    let gm;
    try { gm = await groupMembersForGuard(g.id); }
    catch (e: any) { out.errors.push({ groupId: g.id, groupName: g.name, error: e?.message || String(e) }); continue; }
    out.scanned++;
    const hits: ScanHit[] = [];
    for (const m of gm.members) {
      const reason = candidate(m, c);
      if (reason) hits.push({ groupId: g.id, groupName: gm.name, member: m.id, phone: m.phone!, name: m.name, reason, admin: gm.admin });
    }
    out.hits.push(...hits);
    if (remove && hits.length && gm.admin) {
      const res = await removeAndLog(g.id, gm.name, hits.map(h => ({ member: h.member, phone: h.phone, reason: h.reason })));
      out.removed.push(...hits.map(h => { const r = res.find(x => x.member === h.member); return { ...h, ok: !!r?.ok, error: r?.error }; }));
    }
  }
  return out;
}

/** Remove uma pessoa escolhida na tela (depois de uma verificação). */
export async function removeOne(groupId: string, member: string, reason: BlockReason) {
  const info = await groupMemberInfo(groupId, member).catch(() => null);
  if (info?.mine || info?.admin) throw new Error('Esse membro é administrador (ou um número nosso) e não sai por aqui.');
  const phone = info?.phone || (member.endsWith('@s.whatsapp.net') ? digits(member.split('@')[0]) : member);
  const gm = await groupMembersForGuard(groupId).catch(() => null);
  const [r] = await removeAndLog(groupId, gm?.name || null, [{ member, phone, reason }]);
  return r;
}

/** O que a tela mostra: configuração, últimas remoções e totais. */
export async function guardOverview() {
  const config = await getGuardConfig();
  const blocks = await prisma.groupBlock.findMany({ orderBy: { at: 'desc' }, take: 150 });
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [total, today, failed] = await Promise.all([
    prisma.groupBlock.count({ where: { ok: true } }),
    prisma.groupBlock.count({ where: { ok: true, at: { gte: start } } }),
    prisma.groupBlock.count({ where: { ok: false, at: { gte: new Date(Date.now() - 7 * 86_400_000) } } })
  ]);
  return { config, blocks, counts: { total, today, failed } };
}
