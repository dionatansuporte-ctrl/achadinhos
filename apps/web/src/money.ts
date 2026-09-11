/**
 * Dinheiro no padrão brasileiro: vírgula nos centavos, ponto nos milhares.
 * Usado em todo lugar que mostra ou lê preço no painel.
 */

/** 1299.9 → "R$ 1.299,90". Sem valor → "—" (ou o fallback informado). */
export function brl(n?: number | string | null, fallback = '—'): string {
  const v = typeof n === 'string' ? parseBr(n) : n;
  if (v == null || !Number.isFinite(v)) return fallback;
  return `R$ ${formatBr(v)}`;
}

/** 1299.9 → "1.299,90" (sem o R$). */
export function formatBr(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Lê o que o usuário digitou, aceitando "1.299,90", "1299,90", "1299.90", "R$ 199,9" e "200".
 * Regra: se tem vírgula, ela é o decimal e os pontos são milhar. Se só tem ponto e
 * ele deixa 1–2 dígitos no fim ("199.90"), é decimal; senão é milhar ("1.299").
 */
export function parseBr(raw?: string | null): number | undefined {
  const t = (raw || '').replace(/[^\d.,]/g, '');
  if (!t) return undefined;
  let normalized: string;
  if (t.includes(',')) normalized = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(t) && (t.match(/\./g) || []).length === 1) normalized = t;
  else normalized = t.replace(/\./g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/** Enquanto digita: só dígitos, ponto e vírgula. */
export function typingMoney(raw: string): string {
  return raw.replace(/[^\d.,]/g, '');
}

/** Ao sair do campo: arruma para "1.299,90". Campo vazio continua vazio. */
export function blurMoney(raw: string): string {
  const v = parseBr(raw);
  return v == null ? '' : formatBr(v);
}
