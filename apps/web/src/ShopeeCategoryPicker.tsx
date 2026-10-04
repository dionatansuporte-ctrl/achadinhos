/**
 * Categorias da Shopee encontradas no "Testar busca agora", com exemplos de produto.
 * A busca por nome genérico ("Eletrônicos") traz balança, isca de barata, saquinho...
 * Aqui o usuário recusa a categoria inteira e a automação não envia mais nada dela.
 * A Shopee não informa o nome da categoria, só o número: os exemplos mostram do que se trata.
 */
type Offer = { itemId: string; title: string; categoryIds?: number[]; marketplace?: string };

export default function ShopeeCategoryPicker({ offers, exclude, onChange }: { offers: Offer[]; exclude: number[]; onChange: (v: number[]) => void }) {
  const groups = new Map<number, string[]>();
  for (const o of offers) {
    const c = o.categoryIds?.[0];
    if (!c || (o.marketplace && o.marketplace !== 'SHOPEE')) continue;
    groups.set(c, [...(groups.get(c) || []), o.title]);
  }
  // Recusadas que não vieram nesta busca continuam aparecendo, para poder liberar de volta.
  for (const c of exclude) if (!groups.has(c)) groups.set(c, []);
  if (groups.size < 2 && !exclude.length) return null;
  const toggle = (c: number) => onChange(exclude.includes(c) ? exclude.filter(x => x !== c) : [...exclude, c]);
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  return (
    <div className="niche-sub" style={{ textAlign: 'left' }}>
      <div className="niche-sub-head">
        <b>Categorias da Shopee nesta busca</b>
        <small className="muted">Clique para recusar a categoria que não tem a ver com o grupo. Os produtos dela ficam apagados na prévia e a automação não envia mais.</small>
      </div>
      <div className="cat-groups">
        {sorted.map(([c, titles]) => {
          const off = exclude.includes(c);
          return (
            <div className="cat-group" key={c}>
              <div className="niche-grid" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className={off ? '' : 'chosen'} onClick={() => toggle(c)}>
                  {off ? '✕ Recusada' : '✓ Enviar'} · categoria {c}{titles.length ? ` (${titles.length})` : ''}
                </button>
              </div>
              <small className="muted">{titles.length ? titles.slice(0, 3).map(t => t.slice(0, 50)).join(' · ') : 'não apareceu nesta busca'}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
