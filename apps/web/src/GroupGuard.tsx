import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Save, Search, ShieldBan, Trash2 } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';

/**
 * Tela "Proteção dos grupos" (pedido do usuário em 2026-10-14): o robô tira sozinho de cada grupo quem entra com
 * número estrangeiro (DDI fora da lista permitida) ou com número/prefixo bloqueado, como os contatos de robô
 * +62 858-3467-6571 e +63 975 291 1836 que o usuário removia na mão. Aqui se ajustam as regras, verifica-se quem
 * está nos grupos agora e vê-se quem o robô já removeu.
 */

type Config = { enabled: boolean; sweep: boolean; allowedDdi: string[]; blocked: string[] };
type Block = { id: string; groupId: string; groupName: string | null; member: string; reason: string; ok: boolean; error: string | null; at: string };
type Hit = { groupId: string; groupName: string; member: string; phone: string; name: string | null; reason: string; admin: boolean };
type Scan = { scanned: number; hits: Hit[]; errors: { groupId: string; groupName: string; error: string }[]; removed: (Hit & { ok: boolean; error?: string })[] };
type Group = { id: string; name: string; participants: number; admins?: string[] };

const REASON: Record<string, string> = { FOREIGN: 'número estrangeiro', PREFIX: 'prefixo bloqueado', NUMBER: 'número bloqueado' };
const fmtPhone = (p: string) => /^[0-9]+$/.test(p) ? `+${p}` : p;
const when = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const splitList = (s: string) => s.split(/[\s,;]+/).map(x => x.replace(/[^0-9]/g, '')).filter(Boolean);

export default function GroupGuard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [allowed, setAllowed] = useState('');
  const [blocked, setBlocked] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [counts, setCounts] = useState({ total: 0, today: 0, failed: 0 });
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.get('/api/whatsapp/groups/guard').then(r => {
    const c: Config = r.data.config;
    setConfig(c); setAllowed(c.allowedDdi.join(', ')); setBlocked(c.blocked.join('\n'));
    setBlocks(r.data.blocks || []); setCounts(r.data.counts || { total: 0, today: 0, failed: 0 });
  }).catch(e => setMsg(e?.response?.data?.error || 'Desculpe, não consegui carregar a proteção dos grupos. Tente de novo.'));

  useEffect(() => {
    load();
    api.get('/api/whatsapp/groups').then(r => setGroups(r.data)).catch(() => setGroups([]));
  }, []);

  async function save() {
    if (!config) return;
    setBusy('save'); setMsg('');
    try {
      const r = await api.put('/api/whatsapp/groups/guard', { enabled: config.enabled, sweep: config.sweep, allowedDdi: splitList(allowed), blocked: splitList(blocked) });
      setConfig(r.data); setAllowed(r.data.allowedDdi.join(', ')); setBlocked(r.data.blocked.join('\n'));
      notify('Proteção dos grupos salva.');
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui salvar. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  async function check(remove: boolean) {
    const sel = groups.find(g => g.id === groupId);
    if (remove && !confirm(`Remover agora todo mundo que a verificação achou${sel ? ` no grupo "${sel.name}"` : ' em todos os grupos'}? Quem for removido não recebe mais as ofertas.`)) return;
    setBusy(remove ? 'remove' : 'scan'); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/groups/guard/scan', { groupId: groupId || undefined, remove });
      setScan(r.data);
      if (remove) { notify(`${r.data.removed.filter((x: any) => x.ok).length} pessoa(s) removida(s).`); load(); }
      else if (!r.data.hits.length) notify(r.data.scanned ? 'Tudo certo: ninguém para remover.' : 'Nenhum grupo pôde ser lido.');
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui verificar os grupos. Tente de novo.'); }
    finally { setBusy(''); }
  }

  async function removeOne(h: Hit) {
    if (!confirm(`Remover ${fmtPhone(h.phone)} do grupo "${h.groupName}"?`)) return;
    setBusy(h.groupId + h.member); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/groups/guard/remove', { groupId: h.groupId, member: h.member, reason: h.reason });
      if (r.data.ok) { notify(`${fmtPhone(h.phone)} removido(a).`); setScan(s => s ? { ...s, hits: s.hits.filter(x => x !== h) } : s); load(); }
      else notify(`Não consegui remover ${fmtPhone(h.phone)}: ${r.data.error || 'o WhatsApp não deixou'}.`, 'error');
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui remover. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  const pending = scan ? scan.hits.filter(h => !scan.removed.some(r => r.member === h.member && r.groupId === h.groupId && r.ok)) : [];
  const noAdmin = pending.filter(h => !h.admin).length;

  return (
    <section className="page">
      <h1>Proteção dos grupos</h1>
      <p>O robô tira sozinho dos grupos quem entra com número de fora do Brasil ou com número/prefixo bloqueado: é assim que os contatos de robô (como +62 858-3467-6571 ou +63 975 291 1836) ficam de fora sem você precisar remover na mão.</p>
      {msg && <div className="card"><b className="inline-msg">{msg}</b></div>}

      <div className="card">
        <div className="card-head">
          <div><ShieldBan size={20} /><h3>Regras</h3></div>
          <span className={`badge ${config?.enabled ? 'badge-on' : 'badge-off'}`}>{config?.enabled && <CheckCircle2 size={15} />}{config ? (config.enabled ? 'Proteção ligada' : 'Proteção desligada') : 'Carregando...'}</span>
        </div>
        {config && (
          <>
            <label className="offer-row" style={{ cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} />
              <span><b>Remover na hora quem entrar</b><br /><small className="muted">Cada entrada num grupo é conferida assim que o WhatsApp avisa. Quem não passar nas regras é removido em segundos.</small></span>
            </label>
            <label className="offer-row" style={{ cursor: 'pointer', marginBottom: 10 }}>
              <input type="checkbox" checked={config.sweep} onChange={e => setConfig({ ...config, sweep: e.target.checked })} />
              <span><b>Varrer todos os grupos a cada 6 horas</b><br /><small className="muted">Pega quem entrou enquanto o sistema estava desligado. Antes de ligar, use "Verificar agora" abaixo para ver quem sairia.</small></span>
            </label>
            <div className="env-field" style={{ marginTop: 14 }}>
              <label>DDIs permitidos <em>só estes países ficam</em></label>
              <input value={allowed} onChange={e => setAllowed(e.target.value)} placeholder="55" />
              <small>Código do país, sem o +. Brasil é 55. Para aceitar também Portugal, por exemplo: <b>55, 351</b>. Todo número que não começar com um destes é tratado como estrangeiro e removido.</small>
            </div>
            <div className="env-field">
              <label>Números ou prefixos bloqueados <em>um por linha ou separados por vírgula</em></label>
              <textarea value={blocked} onChange={e => setBlocked(e.target.value)} placeholder={'62\n63\n5544999999999'} />
              <small>Um prefixo barra todo número que começa com ele (62 = Indonésia, 63 = Filipinas, de onde vêm muitos robôs). Um número completo, com DDI e DDD (ex.: 5544999999999), barra só aquele contato, mesmo sendo do Brasil. Pode colar com +, espaços e traços: só os dígitos contam.</small>
            </div>
            <div className="card-actions" style={{ marginTop: 0 }}>
              <button className="primary" disabled={busy === 'save'} onClick={save}><Save size={16} /> {busy === 'save' ? 'Salvando...' : 'Salvar regras'}</button>
            </div>
            <p className="hint">Só funciona nos grupos em que um número seu é <b>administrador</b> (é o WhatsApp que exige). Administradores do grupo e os seus próprios números nunca são removidos. Em grupos "anônimos", em que o WhatsApp esconde o telefone dos membros, não dá para saber o país e a pessoa fica.</p>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div><Search size={20} /><h3>Verificar agora</h3></div>
        </div>
        <p className="muted">Lê quem está nos grupos neste momento e mostra quem deveria sair pelas regras acima. Nada é removido até você mandar.</p>
        <div className="capture-actions" style={{ marginTop: 8 }}>
          <select value={groupId} onChange={e => { setGroupId(e.target.value); setScan(null); }} style={{ minWidth: 260 }}>
            <option value="">Todos os grupos ({groups.length})</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name} · {g.participants} membros</option>)}
          </select>
          <button className="outline" disabled={!!busy || !groups.length} onClick={() => check(false)}><RefreshCw size={16} /> {busy === 'scan' ? 'Verificando...' : 'Verificar'}</button>
          {pending.length > 0 && <button className="primary" disabled={!!busy} onClick={() => check(true)}><Trash2 size={16} /> {busy === 'remove' ? 'Removendo...' : `Remover todos (${pending.length})`}</button>}
        </div>
        {!groups.length && <p className="hint">Conecte o WhatsApp em Canais para listar os grupos.</p>}

        {scan && (
          <div style={{ marginTop: 14 }}>
            <p className="muted">{scan.scanned} grupo(s) lido(s) · {scan.hits.length} pessoa(s) para remover{scan.removed.length ? ` · ${scan.removed.filter(r => r.ok).length} removida(s) agora` : ''}.</p>
            {noAdmin > 0 && <p className="inline-msg"><AlertTriangle size={15} style={{ verticalAlign: -2 }} /> Em {noAdmin === pending.length ? 'todos' : 'alguns'} desses grupos nenhum número seu é administrador: o WhatsApp não deixa remover. Promova o número principal a administrador e verifique de novo.</p>}
            {scan.errors.map(e => <p className="inline-msg" key={e.groupId}>{e.groupName}: {e.error}</p>)}
            {pending.length > 0 && (
              <div className="sales-list">
                {pending.map(h => (
                  <div className="sales-row" key={h.groupId + h.member}>
                    <div className="sales-row-main">
                      <b>{fmtPhone(h.phone)}{h.name ? ` · ${h.name}` : ''}</b>
                      <small>{h.groupName} · {REASON[h.reason] || h.reason}{!h.admin ? ' · sem administrador nosso neste grupo' : ''}</small>
                    </div>
                    <button className="outline" disabled={!!busy || !h.admin} onClick={() => removeOne(h)}><Trash2 size={15} /> Remover</button>
                  </div>
                ))}
              </div>
            )}
            {scan.removed.filter(r => !r.ok).map(r => <p className="inline-msg" key={'f' + r.groupId + r.member}>Não consegui remover {fmtPhone(r.phone)} de {r.groupName}: {r.error || 'o WhatsApp não deixou'}.</p>)}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div><ShieldBan size={20} /><h3>Removidos pelo robô</h3></div>
          <button className="icon-btn" title="Atualizar" onClick={load}><RefreshCw size={16} /></button>
        </div>
        <div className="sales-kpis">
          <div><small>Hoje</small><strong>{counts.today}</strong></div>
          <div><small>No total</small><strong>{counts.total}</strong></div>
          <div><small>Falhas (7 dias)</small><strong>{counts.failed}</strong></div>
        </div>
        {blocks.length ? (
          <div className="sales-list">
            {blocks.map(b => (
              <div className="sales-row" key={b.id}>
                <div className="sales-row-main">
                  <b>{fmtPhone(b.member)}</b>
                  <small>{when(b.at)} · {b.groupName || b.groupId} · {REASON[b.reason] || b.reason}{!b.ok && b.error ? ` · ${b.error}` : ''}</small>
                </div>
                <span className={`badge ${b.ok ? 'badge-on' : 'badge-ready'}`}>{b.ok ? 'Removido' : 'Falhou'}</span>
              </div>
            ))}
          </div>
        ) : <p className="muted">O robô ainda não removeu ninguém. Quando alguém entrar com número estrangeiro ou bloqueado, aparece aqui.</p>}
      </div>
    </section>
  );
}
