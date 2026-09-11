import { brl } from './money';

/**
 * "Comissão 33% · você ganha ≈ R$ 43,00 por venda".
 * Shopee informa os dois; Mercado Livre não informa nada por API.
 */
export function Commission({ rate, value, marketplace, compact }: { rate?: number | string | null; value?: number | string | null; marketplace?: string; compact?: boolean }) {
  const r = rate != null ? Number(rate) : undefined;
  const v = value != null ? Number(value) : undefined;
  if (r == null && v == null) {
    if (marketplace === 'MERCADO_LIVRE') return <span className="commission none" title="O Mercado Livre não informa a comissão por API. Veja no portal de afiliados.">Comissão: ver no portal ML</span>;
    return null;
  }
  const pct = r != null ? `${r.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%` : '';
  if (compact) return <span className="commission" title={`Comissão ${pct}${v != null ? ` · ≈ ${brl(v)} por venda` : ''}`}>💰 {v != null ? `≈ ${brl(v)}` : pct}{v != null && pct ? ` (${pct})` : ''}</span>;
  return (
    <div className="commission" title="Estimativa da plataforma. O valor real depende do preço pago e das regras do programa.">
      <b>💰 {v != null ? `Você ganha ≈ ${brl(v)}` : `Comissão ${pct}`}</b>
      {v != null && <small>{pct ? `${pct} de comissão` : 'comissão'} por venda</small>}
    </div>
  );
}
