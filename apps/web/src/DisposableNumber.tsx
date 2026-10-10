import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, LogOut, Recycle, RefreshCw, Smartphone } from 'lucide-react';
import { api } from './api';
import GroupContacts from './GroupContacts';

// A sessão fixa "descartavel" da API: um número à parte, usado só para adicionar contatos nos grupos.
type Session = { id: string; disposable?: boolean; status: 'disconnected' | 'connecting' | 'qr' | 'connected'; qr?: string | null; me?: { id: string; name?: string } | null; error?: string | null; hasSession?: boolean };
type Group = { id: string; name: string; participants: number; sessions?: string[]; admins?: string[] };
const ID = 'descartavel';

/**
 * Tela "Número descartável" (pedido do usuário em 2026-10-09): pareia um chip separado do principal, que só serve
 * para adicionar contatos nos grupos (e mandar o link de convite a quem a privacidade barrar). Ele não manda oferta,
 * não responde cliente e não conta no limite de 4 números. Se o WhatsApp bloquear, troca-se o chip sem mexer no resto.
 */
export default function DisposableNumber() {
  const [session, setSession] = useState<Session | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = () => api.get('/api/whatsapp/status').then(r => setSession((r.data.sessions || []).find((s: Session) => s.disposable || s.id === ID) || null)).catch(() => {});
  const pairing = (s: Session | null) => !!s && (s.status === 'connecting' || s.status === 'qr');
  const connected = session?.status === 'connected';

  // Enquanto pareia, consulta o status a cada 2s para mostrar o QR e perceber a conexão.
  useEffect(() => {
    refresh();
    // Também enquanto o estado ainda não veio (a primeira consulta falhou): senão ficava "Carregando..." para sempre.
    timer.current = window.setInterval(() => { setSession(prev => { if (!prev || pairing(prev)) refresh(); return prev; }); }, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  useEffect(() => { if (connected) loadGroups(); else setGroups(null); }, [connected]);

  async function loadGroups() {
    setMsg('');
    try {
      const r = await api.get('/api/whatsapp/groups');
      // Só os grupos em que o número descartável está: são os únicos em que ele consegue adicionar alguém.
      setGroups((r.data as Group[]).filter(g => g.sessions?.includes(ID)));
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível listar os grupos.'); setGroups([]); }
  }

  async function connect() {
    setMsg(''); setBusy(true);
    try { await api.post('/api/whatsapp/connect', { session: ID }); setSession(s => s ? { ...s, status: 'connecting', error: null } : s); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui iniciar a conexão. Tente de novo.'); }
    finally { setBusy(false); }
  }

  async function logout(swap = false) {
    if (connected && !confirm(swap
      ? `Trocar o número descartável? O +${session?.me?.id || ''} é desconectado e você escaneia o QR code com o chip novo. Importações que estavam rodando por ele ficam esperando.`
      : `Desconectar o número descartável +${session?.me?.id || ''}? Será preciso escanear o QR code de novo para usar.`)) return;
    setBusy(true); setMsg('');
    try { await api.post('/api/whatsapp/logout', { session: ID }); await refresh(); if (swap) await connect(); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui desconectar. Tente de novo.'); }
    finally { setBusy(false); }
  }

  const admin = (g: Group) => !!g.admins?.includes(ID);

  return (
    <section className="page">
      <h1>Número descartável</h1>
      <p>Um chip à parte, só para adicionar contatos nos grupos de ofertas. Ele não manda ofertas nem responde clientes: isso continua com o número principal. Se o WhatsApp bloquear este chip, é só trocar por outro aqui, sem mexer no resto.</p>

      <div className="card">
        <div className="card-head">
          <div><Recycle size={20} /><h3>Chip descartável</h3></div>
          <span className={`badge ${connected ? 'badge-on' : pairing(session) ? 'badge-ready' : 'badge-off'}`}>
            {connected && <CheckCircle2 size={15} />}
            {connected ? `Conectado · +${session?.me?.id || ''}` : pairing(session) ? 'Aguardando leitura do QR' : 'Desconectado'}
          </span>
        </div>

        {connected && (
          <div className="wa-number">
            <Smartphone size={18} />
            <span className="wa-number-name">+{session?.me?.id}{session?.me?.name ? ` · ${session.me.name}` : ''}</span>
            <span className="badge badge-ready">Só adiciona contatos</span>
            <button className="outline" disabled={busy} onClick={() => logout(true)}><RefreshCw size={16} /> Trocar número</button>
            <button className="outline" disabled={busy} onClick={() => logout(false)}><LogOut size={16} /> Desconectar</button>
          </div>
        )}

        {session?.status === 'disconnected' && (
          <div className="wa-connect">
            <Recycle size={40} />
            <p className="muted">Conecte o chip descartável como no WhatsApp Web: você escaneia um QR code pelo celular dele. Depois de pareado, o chip pode ficar guardado; a sessão fica salva no sistema.</p>
            <button className="primary" disabled={busy} onClick={connect}><Smartphone size={17} /> Conectar número descartável</button>
            {session.error && <p className="inline-msg">{session.error}</p>}
          </div>
        )}

        {pairing(session) && (
          <div className="wa-connect">
            <p className="muted" style={{ margin: 0 }}><b>Atenção:</b> escaneie com o celular do chip descartável, não com o número principal.</p>
            {session?.qr ? <img src={session.qr} alt="QR code do WhatsApp" className="wa-qr" /> : <div className="wa-qr wa-qr-wait">Gerando QR...</div>}
            <p className="muted" style={{ maxWidth: 420 }}>No celular: <b>WhatsApp → Dispositivos conectados → Conectar dispositivo</b> e aponte para o código.</p>
            <button className="outline" onClick={() => logout(false)}>Cancelar</button>
          </div>
        )}

        {!session && <p className="muted">Carregando...</p>}

        <p className="hint">Funciona melhor com um chip pré-pago comum (Vivo, Claro, Tim) em um celular secundário. Número virtual de site ou app costuma ser barrado pelo WhatsApp. Use o WhatsApp Business nele, com foto e nome da loja, e deixe uns dias "aquecendo" (conversando, entrando em grupos) antes de importar. O sistema só começa a adicionar 1 hora depois de escanear o QR code.</p>
        <p className="hint">Quem responder a este número não recebe resposta do robô: o atendimento continua só pelo número principal. Quem a privacidade barrar de ser adicionado recebe o link de convite por este número.</p>
        {msg && <p className="inline-msg">{msg}</p>}
      </div>

      {connected && (
        <div className="card">
          <div className="card-head">
            <div><Smartphone size={20} /><h3>Grupos em que o descartável está</h3></div>
            <button className="outline" disabled={busy} onClick={loadGroups}><RefreshCw size={16} /> Atualizar</button>
          </div>
          {groups === null ? <p className="muted">Carregando grupos...</p> : groups.length ? (
            <>
              <p className="muted">Para adicionar gente, o descartável precisa ser <b>administrador</b> do grupo de destino. Coloque-o no grupo pelo número principal e promova a administrador.</p>
              <div className="wa-groups">
                {groups.map(g => (
                  <div className="wa-group" key={g.id}>
                    <span className="wa-group-name">{g.name}</span>
                    <small>{g.participants} membros</small>
                    <span className={`badge ${admin(g) ? 'badge-on' : 'badge-off'}`}>{admin(g) ? 'Administrador' : 'Só membro'}</span>
                  </div>
                ))}
              </div>
              <GroupContacts groups={groups} sessions={[{ id: ID, phone: session?.me?.id || '' }]} cautious />
            </>
          ) : (
            <p className="muted">O número descartável ainda não está em nenhum grupo. Adicione-o nos grupos de ofertas pelo número principal (e faça dele administrador), depois clique em Atualizar.</p>
          )}
        </div>
      )}
    </section>
  );
}
