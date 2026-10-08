import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LogOut, MessageCircle, Pause, Play, Plus, RefreshCw, Smartphone } from 'lucide-react';
import { api } from './api';
import GroupContacts from './GroupContacts';

// Um número de WhatsApp pareado (ou pareando). "principal" é o primeiro; os outros são n2, n3...
type Session = { id: string; main: boolean; status: 'disconnected' | 'connecting' | 'qr' | 'connected'; qr?: string | null; me?: { id: string; name?: string } | null; error?: string | null; hasSession?: boolean };
type Group = { id: string; name: string; participants: number; session?: string };
type Channel = { id: string; type: string; destination: string; enabled: boolean };

/** Painel de pareamento dos números de WhatsApp por QR code e escolha dos grupos que recebem ofertas (enviar / parar envio). */
export default function WhatsAppWeb({ channels, onChanged }: { channels: Channel[]; onChanged: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = () => api.get('/api/whatsapp/status').then(r => setSessions(r.data.sessions || [])).catch(() => {});
  const pairing = (s: Session) => s.status === 'connecting' || s.status === 'qr';

  // Enquanto algum número pareia, consulta o status a cada 2s para mostrar o QR e detectar a conexão.
  useEffect(() => {
    refresh();
    timer.current = window.setInterval(() => {
      setSessions(prev => { if (prev.some(pairing)) refresh(); return prev; });
    }, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const connected = sessions.filter(s => s.status === 'connected');
  // Recarrega os grupos sempre que muda quem está conectado (um número novo traz os grupos dele).
  const connectedKey = connected.map(s => s.id).join(',');
  useEffect(() => { if (connectedKey) loadGroups(); else setGroups([]); }, [connectedKey]);

  async function connect(id: string) {
    setMsg(''); setBusy(true);
    try { await api.post('/api/whatsapp/connect', { session: id }); setSessions(list => list.map(s => s.id === id ? { ...s, status: 'connecting', error: null } : s)); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui iniciar a conexão. Tente de novo.'); }
    finally { setBusy(false); }
  }

  async function addNumber() {
    setMsg(''); setBusy(true);
    try { await api.post('/api/whatsapp/sessions'); await refresh(); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui gerar o QR code do novo número. Tente de novo.'); }
    finally { setBusy(false); }
  }

  async function logout(s: Session) {
    if (s.status === 'connected' && !confirm(`Desconectar o WhatsApp +${s.me?.id || ''}? Será preciso escanear o QR code de novo, e os grupos dele param de receber ofertas.`)) return;
    setBusy(true);
    try { await api.post('/api/whatsapp/logout', { session: s.id }); setPicked({}); await refresh(); }
    finally { setBusy(false); }
  }

  // Número de cada sessão, para mostrar por qual número sai cada grupo quando há mais de um.
  const phoneOf = new Map(sessions.map(s => [s.id, s.me?.id ? `+${s.me.id}` : '']));

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
        <span className={`badge ${connected.length ? 'badge-on' : sessions.some(pairing) ? 'badge-ready' : 'badge-off'}`}>
          {connected.length > 0 && <CheckCircle2 size={15} />}
          {connected.length > 1 ? `${connected.length} números conectados` : connected.length ? `Conectado · +${connected[0].me?.id || ''}` : sessions.some(pairing) ? 'Aguardando leitura do QR' : 'Desconectado'}
        </span>
      </div>

      {sessions.map(s => (
        <div key={s.id}>
          {s.status === 'connected' && (
            <div className="wa-number">
              <Smartphone size={18} />
              <span className="wa-number-name">+{s.me?.id}{s.me?.name ? ` · ${s.me.name}` : ''}</span>
              {s.main && <span className="badge badge-ready">Principal</span>}
              <span className="badge badge-on">Conectado</span>
              <button className="outline" disabled={busy} onClick={() => logout(s)}><LogOut size={16} /> Desconectar</button>
            </div>
          )}

          {/* Nenhum número conectado ainda: o convite grande para conectar o primeiro. */}
          {s.status === 'disconnected' && s.main && !connected.length && (
            <div className="wa-connect">
              <Smartphone size={40} />
              <p className="muted">Conecte o seu WhatsApp para listar os grupos e enviar as ofertas neles. Funciona como o WhatsApp Web: você escaneia um QR code pelo celular.</p>
              <p className="hint" style={{ margin: 0 }}>Este caminho usa uma conexão não oficial. Prefira um número secundário — há risco de bloqueio pela Meta com volume alto.</p>
              <button className="primary" disabled={busy} onClick={() => connect(s.id)}><Smartphone size={17} /> Conectar WhatsApp</button>
              {s.error && <p className="inline-msg">{s.error}</p>}
            </div>
          )}

          {s.status === 'disconnected' && (!s.main || connected.length > 0) && (
            <div className="wa-number">
              <Smartphone size={18} />
              <span className="wa-number-name">{s.main ? 'Número principal' : 'Outro número'} — desconectado</span>
              <button className="outline" disabled={busy} onClick={() => connect(s.id)}><Smartphone size={16} /> Gerar QR code</button>
              {!s.main && <button className="outline" disabled={busy} onClick={() => logout(s)}>Remover</button>}
              {s.error && <p className="inline-msg" style={{ flexBasis: '100%' }}>{s.error}</p>}
            </div>
          )}

          {pairing(s) && (
            <div className="wa-connect">
              {!s.main && <p className="muted" style={{ margin: 0 }}><b>Novo número:</b> escaneie com o celular do número que você quer adicionar.</p>}
              {s.qr ? <img src={s.qr} alt="QR code do WhatsApp" className="wa-qr" /> : <div className="wa-qr wa-qr-wait">Gerando QR...</div>}
              <p className="muted" style={{ maxWidth: 420 }}>No celular: <b>WhatsApp → Dispositivos conectados → Conectar dispositivo</b> e aponte para o código.</p>
              <button className="outline" onClick={() => logout(s)}>Cancelar</button>
            </div>
          )}
        </div>
      ))}

      {/* No máximo 4 contas (pedido do usuário em 2026-10-08). */}
      {connected.length > 0 && sessions.length < 4 && !sessions.some(s => !s.main && pairing(s)) && (
        <div className="capture-actions" style={{ marginTop: 10 }}>
          <button className="outline" disabled={busy} onClick={addNumber}><Plus size={16} /> Adicionar outro número</button>
        </div>
      )}
      {connected.length > 0 && <p className="hint">Dá para conectar até 4 números, cada um com o seu QR code. A oferta de um grupo sai pelo número que está nele; com vários números, dá para dividir os grupos entre eles e diminuir o volume de cada um.</p>}

      {connected.length > 0 && (
        <>
          <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar grupo pelo nome" />
            <button className="outline" onClick={loadGroups}><RefreshCw size={16} /> Atualizar</button>
          </div>
          {groups.length ? (
            <>
              <p className="muted" style={{ marginTop: 14 }}>{shown.length} grupo(s). Ligue ou pare o envio de ofertas em cada grupo, ou marque vários e use os botões abaixo:</p>
              <div className="wa-groups">
                {shown.map(g => (
                  <label className={`wa-group ${picked[g.id] ? 'on' : ''}`} key={g.id}>
                    <input type="checkbox" checked={!!picked[g.id]} onChange={e => setPicked(v => ({ ...v, [g.id]: e.target.checked }))} />
                    <span className="wa-group-name">{g.name}</span>
                    <small>{g.participants} membros{connected.length > 1 && g.session && phoneOf.get(g.session) ? ` · via ${phoneOf.get(g.session)}` : ''}</small>
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
              <GroupContacts groups={groups} sessions={connected.map(s => ({ id: s.id, phone: s.me?.id || "" }))} />
            </>
          ) : <p className="muted" style={{ marginTop: 14 }}>Carregando grupos...</p>}
        </>
      )}

      {msg && <p className="inline-msg">{msg}</p>}
    </div>
  );
}
