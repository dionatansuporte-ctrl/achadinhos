import { useEffect, useState } from 'react';
import { CheckCircle2, Link2, Megaphone, Pause, Play, Plus, Send, Trash2 } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';

/**
 * Tela "Canais do WhatsApp" (pedido do usuário em 2026-10-29): dispara ofertas nos canais do WhatsApp, aqueles de
 * seguidores (aba Atualizações). O WhatsApp não deixa listar os canais da conta, então o canal entra pelo link.
 * Cadastrado, ele vira um canal de envio comum: aparece em Canais e nas automações, como os grupos.
 */

type Info = { id: string; name: string; description: string; followers: number; invite: string | null; role: string; session: string | null; canPost: boolean };
type Channel = { id: string; name: string; destination: string; enabled: boolean; configJson?: { invite?: string | null; followers?: number; role?: string; checkedAt?: number } | null };

const ROLE: Record<string, string> = { OWNER: 'dono', ADMIN: 'administrador', SUBSCRIBER: 'só seguidor', GUEST: 'não segue' };

export default function WhatsAppChannels() {
  const [list, setList] = useState<Channel[] | null>(null);
  const [link, setLink] = useState('');
  const [found, setFound] = useState<Info | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.get('/api/whatsapp/news-channels').then(r => setList(r.data)).catch(() => setList([]));
  useEffect(() => { load(); }, []);

  async function lookup() {
    if (!link.trim()) return setMsg('Cole o link do canal.');
    setBusy('lookup'); setMsg(''); setFound(null);
    try { const r = await api.post('/api/whatsapp/news-channels/lookup', { link }); setFound(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui procurar o canal. Tente de novo.'); }
    finally { setBusy(''); }
  }

  async function add() {
    setBusy('add'); setMsg('');
    try {
      const r = await api.post('/api/whatsapp/news-channels', { link });
      notify(r.data.created ? `Pronto! O canal "${r.data.info.name}" vai receber as ofertas.` : `O canal "${r.data.info.name}" já estava cadastrado e voltou a receber ofertas.`);
      setLink(''); setFound(null); await load();
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Desculpe, não consegui cadastrar o canal. Tente de novo.'); }
    finally { setBusy(''); }
  }

  async function toggle(c: Channel) {
    setBusy(c.id);
    try { await api.patch(`/api/channels/${c.id}`, { enabled: !c.enabled }); notify(c.enabled ? `Envio parado no canal "${c.name}".` : `O canal "${c.name}" voltou a receber ofertas.`); await load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não deu certo. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  async function test(c: Channel) {
    setBusy(c.id);
    try { await api.post(`/api/whatsapp/news-channels/${c.id}/test`); notify(`Mensagem de teste enviada no canal "${c.name}". Confira no celular!`); await load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, o teste não saiu. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  async function remove(c: Channel) {
    if (!confirm(`Tirar o canal "${c.name}" do robô? Ele para de receber ofertas (o canal no WhatsApp continua existindo).`)) return;
    setBusy(c.id);
    try { await api.delete(`/api/channels/${c.id}`); notify('Canal removido do robô.'); await load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui remover. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  return (
    <section className="page">
      <h1>Canais do WhatsApp</h1>
      <p>Os canais de seguidores do WhatsApp (aba <b>Atualizações</b>). A oferta publicada no canal chega a todos os seguidores, sem limite de pessoas como nos grupos.</p>

      <div className="card">
        <div className="card-head"><div><Plus size={20} /><h3>Adicionar canal</h3></div></div>
        <div className="form-row form-row-tight">
          <input value={link} onChange={e => { setLink(e.target.value); setFound(null); }} onKeyDown={e => { if (e.key === 'Enter') lookup(); }} placeholder="Link do canal: https://whatsapp.com/channel/0029Va..." />
          <button className="outline" disabled={!!busy} onClick={lookup}><Link2 size={16} /> {busy === 'lookup' ? 'Procurando...' : 'Procurar'}</button>
        </div>
        <p className="hint">No celular, abra o canal, toque no nome dele e use <b>Copiar link</b>. O número dono do canal (ou um administrador dele) precisa estar conectado em <b>Canais</b>, porque só dono e administradores publicam.</p>

        {found && (
          <div className="wa-number" style={{ flexWrap: 'wrap' }}>
            <Megaphone size={18} />
            <span className="wa-number-name">{found.name} <small className="muted">· {found.followers} seguidor(es) · robô é {ROLE[found.role] || found.role.toLowerCase()}</small></span>
            {found.canPost
              ? <button className="primary" disabled={!!busy} onClick={add}><CheckCircle2 size={16} /> {busy === 'add' ? 'Cadastrando...' : 'Enviar ofertas neste canal'}</button>
              : <p className="inline-msg" style={{ flexBasis: '100%', margin: 0 }}>Nenhum número conectado é dono ou administrador deste canal, então o robô não consegue publicar nele. Conecte em Canais o número dono do canal, ou adicione o número do robô como administrador (no canal: nome do canal → Administradores → Convidar).</p>}
          </div>
        )}
        {msg && <p className="inline-msg">{msg}</p>}
      </div>

      {list === null && <p className="muted">Carregando...</p>}
      {list && !list.length && (
        <div className="card"><div className="empty"><Megaphone size={48} /><h2>Nenhum canal do WhatsApp ainda</h2><p>Cole o link do seu canal acima para o robô começar a publicar as ofertas nele.</p></div></div>
      )}
      {list && list.length > 0 && (
        <div className="list-grid">
          {list.map(c => (
            <div className="card" key={c.id}>
              <div className="card-head">
                <div><Megaphone size={20} /><h3>{c.name}</h3></div>
                <span className={`badge ${c.enabled ? 'badge-on' : 'badge-off'}`}>{c.enabled ? 'Enviando' : 'Parado'}</span>
              </div>
              <p className="muted">
                Canal do WhatsApp{typeof c.configJson?.followers === 'number' ? ` · ${c.configJson.followers} seguidor(es)` : ''}{c.configJson?.role ? ` · robô é ${ROLE[c.configJson.role] || c.configJson.role.toLowerCase()}` : ''}
                {c.configJson?.invite && <> · <a href={`https://whatsapp.com/channel/${c.configJson.invite}`} target="_blank" rel="noreferrer">abrir canal</a></>}
              </p>
              <div className="card-actions">
                <button className="outline" disabled={busy === c.id} onClick={() => toggle(c)}>{c.enabled ? <><Pause size={16} /> Parar envio</> : <><Play size={16} /> Enviar ofertas</>}</button>
                <button className="outline" disabled={busy === c.id} title="Confere o canal e publica uma mensagem de teste" onClick={() => test(c)}><Send size={16} /> Testar</button>
                <button className="icon-btn" disabled={busy === c.id} title="Tirar o canal do robô" onClick={() => remove(c)}><Trash2 size={18} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {list && list.length > 0 && <p className="hint">Para as ofertas saírem, a automação precisa usar o canal: marque-o na automação ou deixe ela enviar para todos os canais.</p>}
    </section>
  );
}
