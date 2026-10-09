import { useEffect, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { api } from './api';

// link: entrou pelo link (ou pedido aprovado); added: adicionado por alguém; left: saiu; removed: foi removido.
type Counts = { link: number; added: number; left: number; removed: number };
type Growth = { groups: (Counts & { id: string; name: string })[]; days: (Counts & { day: string })[]; trackingSince: string | null };

const PERIODS = [['today', 'Hoje'], ['yesterday', 'Ontem'], ['7d', '7 dias'], ['30d', '30 dias']] as const;
const joined = (c: Counts) => c.link + c.added;
const gone = (c: Counts) => c.left + c.removed;
const fmtNet = (n: number) => n > 0 ? `+${n}` : String(n);
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

/** Quantas pessoas entraram e saíram de cada grupo, no dia ou na semana (pedido do usuário em 2026-10-09). */
export default function GroupGrowth() {
  const [period, setPeriod] = useState<typeof PERIODS[number][0]>('7d');
  const [groupId, setGroupId] = useState('');
  const [r, setR] = useState<Growth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true); setError('');
    api.get(`/api/whatsapp/groups/growth?period=${period}${groupId ? `&groupId=${encodeURIComponent(groupId)}` : ''}`)
      .then(x => setR(x.data))
      .catch(e => setError(e?.response?.data?.error || 'Desculpe, não consegui carregar as entradas nos grupos. Tente de novo.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [period, groupId]);

  const total = r?.groups.reduce((t, g) => ({ link: t.link + g.link, added: t.added + g.added, left: t.left + g.left, removed: t.removed + g.removed }), { link: 0, added: 0, left: 0, removed: 0 });
  const groupName = r?.groups.find(g => g.id === groupId)?.name;

  return (
    <div style={{ marginTop: 22 }}>
      <div className="card-head"><div><TrendingUp size={20} /><h3>Entradas nos grupos</h3></div></div>
      <p className="muted">Quantas pessoas entraram e saíram de cada grupo. Clique num grupo para ver o dia a dia só dele.</p>
      <div className="capture-actions" style={{ marginTop: 8 }}>
        {PERIODS.map(([v, l]) => <button key={v} type="button" className={`outline ${period === v ? 'is-on' : ''}`} onClick={() => setPeriod(v)}>{l}</button>)}
        <button type="button" className="icon-btn" title="Atualizar agora" disabled={loading} onClick={load}><RefreshCw size={16} /></button>
      </div>

      {error && <p className="inline-msg">{error}</p>}
      {!r ? (!error && <p className="muted">Carregando...</p>) : (
        <>
          {total && (
            <div className="sales-kpis" style={{ marginTop: 12 }}>
              <div><small>Entraram</small><strong>{joined(total)}</strong></div>
              <div><small>Saíram</small><strong>{gone(total)}</strong></div>
              <div><small>Saldo</small><strong>{fmtNet(joined(total) - gone(total))}</strong></div>
            </div>
          )}

          <div className="sales-list">
            {r.groups.map(g => (
              <div className="sales-row" key={g.id} style={{ cursor: 'pointer', outline: g.id === groupId ? '2px solid var(--accent-border)' : undefined }} onClick={() => setGroupId(id => id === g.id ? '' : g.id)}>
                <div className="sales-row-main">
                  <b>{g.name}</b>
                  <small>Entraram {joined(g)} ({g.link} pelo link · {g.added} adicionados) · Saíram {gone(g)} ({g.left} saíram · {g.removed} removidos)</small>
                </div>
                <strong>{fmtNet(joined(g) - gone(g))}</strong>
              </div>
            ))}
          </div>

          {r.days.length > 1 && (
            <>
              <h4 style={{ margin: '16px 0 8px', fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                Dia a dia {groupName ? `· ${groupName}` : '· todos os grupos'}
              </h4>
              {groupId && <button type="button" className="outline" style={{ marginBottom: 8 }} onClick={() => setGroupId('')}>Ver todos os grupos</button>}
              <div className="sales-list">
                {r.days.map(d => (
                  <div className="sales-row" key={d.day}>
                    <div className="sales-row-main"><b>{fmtDay(d.day)}</b><small>Entraram {joined(d)} · Saíram {gone(d)}</small></div>
                    <strong>{fmtNet(joined(d) - gone(d))}</strong>
                  </div>
                ))}
              </div>
            </>
          )}

          <small className="muted" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            {r.trackingSince
              ? `Contando desde ${new Date(r.trackingSince).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}. O WhatsApp não informa quem entrou antes disso.`
              : 'A contagem começa agora: o WhatsApp não informa quem entrou antes. Assim que alguém entrar ou sair de um grupo, aparece aqui.'}
            {' '}"Adicionados" inclui quem foi colocado pela importação de contatos.
          </small>
        </>
      )}
    </div>
  );
}
