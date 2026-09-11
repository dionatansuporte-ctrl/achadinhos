import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LogOut, MessageCircle, Plus, RefreshCw, Smartphone } from 'lucide-react';
import { api } from './api';

type State = { status: 'disconnected' | 'connecting' | 'qr' | 'connected'; qr?: string | null; me?: { id: string; name?: string } | null; error?: string | null; hasSession?: boolean };
type Group = { id: string; name: string; participants: number };

/** Painel de pareamento do WhatsApp por QR code e escolha dos grupos que viram canais. */
export default function WhatsAppWeb({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<State>({ status: 'disconnected' });
  const [groups, setGroups] = useState<Group[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = () => api.get('/api/whatsapp/status').then(r => setSt(r.data)).catch(() => {});

  // Enquanto pareia, consulta o status a cada 2s para mostrar o QR e detectar a conexão.
  useEffect(() => {
    refresh();
    timer.current = window.setInterval(() => {
      setSt(prev => { if (prev.status === 'connecting' || prev.status === 'qr') refresh(); return prev; });
    }, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  useEffect(() => { if (st.status === 'connected') loadGroups(); }, [st.status]);

  async function connect() {
    setMsg(''); setBusy(true);
    try { await api.post('/api/whatsapp/connect'); setSt(s => ({ ...s, status: 'connecting' })); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível iniciar a conexão.'); }
    finally { setBusy(false); }
  }

  async function logout() {
    if (!confirm('Desconectar este WhatsApp? Será preciso escanear o QR code de novo.')) return;
    setBusy(true);
    try { await api.post('/api/whatsapp/logout'); setGroups([]); setPicked({}); await refresh(); }
    finally { setBusy(false); }
  }

  async function loadGroups() {
    setMsg('');
    try { const r = await api.get('/api/whatsapp/groups'); setGroups(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível listar os grupos.'); }
  }

  async function addChannels() {
    const chosen = groups.filter(g => picked[g.id]);
    if (!chosen.length) return setMsg('Marque ao menos um grupo.');
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/channels', { groups: chosen.map(g => ({ id: g.id, name: g.name })) });
      setMsg(`${r.data.created} grupo(s) adicionados como canal${r.data.skipped ? `, ${r.data.skipped} já existiam` : ''}.`);
      setPicked({});
      onChanged();
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível adicionar.'); }
    finally { setBusy(false); }
  }

  const shown = groups.filter(g => g.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="card">
      <div className="card-head">
        <div><MessageCircle size={20} /><h3>WhatsApp — grupos</h3></div>
        <span className={`badge ${st.status === 'connected' ? 'badge-on' : st.status === 'disconnected' ? 'badge-off' : 'badge-ready'}`}>
          {st.status === 'connected' && <CheckCircle2 size={15} />}
          {st.status === 'connected' ? `Conectado${st.me?.id ? ` · +${st.me.id}` : ''}` : st.status === 'qr' ? 'Aguardando leitura do QR' : st.status === 'connecting' ? 'Conectando...' : 'Desconectado'}
        </span>
      </div>

      {st.status === 'disconnected' && (
        <div className="wa-connect">
          <Smartphone size={40} />
          <p className="muted">Conecte o seu WhatsApp para listar os grupos e enviar as ofertas neles. Funciona como o WhatsApp Web: você escaneia um QR code pelo celular.</p>
          <p className="hint" style={{ margin: 0 }}>Este caminho usa uma conexão não oficial. Prefira um número secundário — há risco de bloqueio pela Meta com volume alto.</p>
          <button className="primary" disabled={busy} onClick={connect}><Smartphone size={17} /> Conectar WhatsApp</button>
          {st.error && <p className="inline-msg">{st.error}</p>}
        </div>
      )}

      {(st.status === 'connecting' || st.status === 'qr') && (
        <div className="wa-connect">
          {st.qr ? <img src={st.qr} alt="QR code do WhatsApp" className="wa-qr" /> : <div className="wa-qr wa-qr-wait">Gerando QR...</div>}
          <p className="muted" style={{ maxWidth: 420 }}>No celular: <b>WhatsApp → Dispositivos conectados → Conectar dispositivo</b> e aponte para o código.</p>
          <button className="outline" onClick={logout}>Cancelar</button>
        </div>
      )}

      {st.status === 'connected' && (
        <>
          <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar grupo pelo nome" />
            <button className="outline" onClick={loadGroups}><RefreshCw size={16} /> Atualizar</button>
            <button className="outline" onClick={logout}><LogOut size={16} /> Desconectar</button>
          </div>
          {groups.length ? (
            <>
              <p className="muted" style={{ marginTop: 14 }}>{shown.length} grupo(s). Marque os que devem receber as ofertas:</p>
              <div className="wa-groups">
                {shown.map(g => (
                  <label className={`wa-group ${picked[g.id] ? 'on' : ''}`} key={g.id}>
                    <input type="checkbox" checked={!!picked[g.id]} onChange={e => setPicked(v => ({ ...v, [g.id]: e.target.checked }))} />
                    <span className="wa-group-name">{g.name}</span>
                    <small>{g.participants} membros</small>
                  </label>
                ))}
              </div>
              <div className="capture-actions">
                <button className="primary" disabled={busy} onClick={addChannels}><Plus size={17} /> Adicionar selecionados como canais</button>
                <button className="outline" onClick={() => setPicked(Object.fromEntries(shown.map(g => [g.id, true])))}>Marcar todos</button>
                <button className="outline" onClick={() => setPicked({})}>Desmarcar</button>
              </div>
            </>
          ) : <p className="muted" style={{ marginTop: 14 }}>Carregando grupos...</p>}
        </>
      )}

      {msg && <p className="inline-msg">{msg}</p>}
    </div>
  );
}
