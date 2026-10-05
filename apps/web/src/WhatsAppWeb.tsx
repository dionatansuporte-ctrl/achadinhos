import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LogOut, MessageCircle, Pause, Play, RefreshCw, Smartphone } from 'lucide-react';
import { api } from './api';
import GroupContacts from './GroupContacts';

type State = { status: 'disconnected' | 'connecting' | 'qr' | 'connected'; qr?: string | null; me?: { id: string; name?: string } | null; error?: string | null; hasSession?: boolean };
type Group = { id: string; name: string; participants: number };
type Channel = { id: string; type: string; destination: string; enabled: boolean };

/** Painel de pareamento do WhatsApp por QR code e escolha dos grupos que recebem ofertas (enviar / parar envio). */
export default function WhatsAppWeb({ channels, onChanged }: { channels: Channel[]; onChanged: () => void }) {
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

  // Canal de cada grupo (pelo id do grupo), para mostrar se está enviando ou parado.
  const byGroup = new Map(channels.filter(c => c.type === 'WHATSAPP_GROUP').map(c => [c.destination, c]));
  const sending = (g: Group) => !!byGroup.get(g.id)?.enabled;

  async function startSending(chosen: Group[]) {
    if (!chosen.length) return setMsg('Marque ao menos um grupo.');
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/channels', { groups: chosen.map(g => ({ id: g.id, name: g.name })) });
      const on = r.data.created + r.data.resumed;
      setMsg(on ? `Pronto! ${on} grupo(s) passaram a receber ofertas.` : 'Esses grupos já estavam recebendo ofertas.');
      setPicked({});
      onChanged();
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui ligar o envio. Tente de novo.'); }
    finally { setBusy(false); }
  }

  async function stopSending(chosen: Group[]) {
    if (!chosen.length) return setMsg('Marque ao menos um grupo.');
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/channels/pause', { groupIds: chosen.map(g => g.id) });
      setMsg(r.data.paused ? `Envio parado em ${r.data.paused} grupo(s). Ofertas que estavam na fila para eles não saem mais.` : 'Esses grupos já estavam sem envio.');
      setPicked({});
      onChanged();
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui parar o envio. Tente de novo.'); }
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
              <p className="muted" style={{ marginTop: 14 }}>{shown.length} grupo(s). Ligue ou pare o envio de ofertas em cada grupo, ou marque vários e use os botões abaixo:</p>
              <div className="wa-groups">
                {shown.map(g => (
                  <label className={`wa-group ${picked[g.id] ? 'on' : ''}`} key={g.id}>
                    <input type="checkbox" checked={!!picked[g.id]} onChange={e => setPicked(v => ({ ...v, [g.id]: e.target.checked }))} />
                    <span className="wa-group-name">{g.name}</span>
                    <small>{g.participants} membros</small>
                    <span className={`badge ${sending(g) ? 'badge-on' : 'badge-off'}`}>{sending(g) ? 'Enviando' : 'Parado'}</span>
                    <button
                      className="outline wa-group-toggle" disabled={busy}
                      title={sending(g) ? 'Parar de enviar ofertas neste grupo' : 'Enviar ofertas neste grupo'}
                      onClick={e => { e.preventDefault(); if (sending(g)) stopSending([g]); else startSending([g]); }}
                    >{sending(g) ? <Pause size={15} /> : <Play size={15} />}</button>
                  </label>
                ))}
              </div>
              <div className="capture-actions">
                <button className="primary" disabled={busy} onClick={() => startSending(groups.filter(g => picked[g.id]))}><Play size={17} /> Enviar nos selecionados</button>
                <button className="outline" disabled={busy} onClick={() => stopSending(groups.filter(g => picked[g.id]))}><Pause size={17} /> Parar envio nos selecionados</button>
                <button className="outline" onClick={() => setPicked(Object.fromEntries(shown.map(g => [g.id, true])))}>Marcar todos</button>
                <button className="outline" onClick={() => setPicked({})}>Desmarcar</button>
              </div>
              <GroupContacts groups={groups} />
            </>
          ) : <p className="muted" style={{ marginTop: 14 }}>Carregando grupos...</p>}
        </>
      )}

      {msg && <p className="inline-msg">{msg}</p>}
    </div>
  );
}
