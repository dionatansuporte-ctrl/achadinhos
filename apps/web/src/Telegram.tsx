import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Copy, ExternalLink, Plus, Power, RefreshCw, Search, Send, SendHorizontal, Trash2, UserPlus, Users, Zap } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';
import { brl } from './money';

/**
 * Tela "Telegram" (pedido do usuário em 2026-10-16): manda as promoções para canais e grupos do Telegram.
 * Funciona com um bot criado no @BotFather: o token fica salvo criptografado (TELEGRAM_BOT_TOKEN) e cada canal
 * onde o bot é administrador vira um canal do tipo TELEGRAM, que as automações, o Capturar ofertas e o listão
 * de cupons também podem usar. Aqui dá para cadastrar os canais, testar e disparar produtos na hora.
 *
 * Contatos (também 2026-10-16): quem abre o bot e toca em Iniciar aparece aqui e recebe o convite do grupo de ofertas,
 * sozinho e em lote. Oferta nenhuma vai no privado (decisão do usuário): o bot só serve para trazer gente ao grupo.
 */

type Channel = { id: string; name: string; destination: string; enabled: boolean; allAutomations: boolean };
type Contact = { id: number; title: string; username?: string; seenAt: string; invitedAt: string | null };
type Progress = { running: boolean; groupName: string; total: number; sent: number; failed: number; finishedAt: string | null; errors: string[] };
type Contacts = { autoInvite: boolean; inviteGroupId: string | null; list: Contact[]; progress: Progress };
const NO_PROGRESS: Progress = { running: false, groupName: '', total: 0, sent: 0, failed: 0, finishedAt: null, errors: [] };
type Recent = { id: string; status: string; error: string | null; createdAt: string; sentAt: string | null; title: string; imageUrl: string | null; price: number | null; channel: { id: string; name: string }; link: string | null };
type Product = { id: string; title: string; imageUrl?: string | null; price?: string | number | null; oldPrice?: string | number | null; discountPercent?: number | null; marketplace: string; active: boolean; createdAt: string };

const when = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const stLabel = (s: string) => s === 'SENT' ? 'Enviado' : s === 'FAILED' ? 'Falhou' : s === 'PROCESSING' ? 'Enviando' : 'Na fila';
const stClass = (s: string) => s === 'SENT' ? 'badge-on' : s === 'FAILED' ? 'badge-off' : 'badge-ready';
const chatLink = (d: string) => d.startsWith('@') ? `https://t.me/${d.slice(1)}` : null;

export default function TelegramPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [tokenMasked, setTokenMasked] = useState('');
  const [bot, setBot] = useState<{ username: string; name: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(true);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  // Canal do usuário (informado em 2026-10-16): já vem preenchido para cadastrar com um clique.
  const [dest, setDest] = useState('@ofertasdahoraj');
  const [chanName, setChanName] = useState('');
  const [discovered, setDiscovered] = useState<any[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [fromTo, setFromTo] = useState(true);
  const [freeText, setFreeText] = useState('');
  const [freeImage, setFreeImage] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [contacts, setContacts] = useState<Contacts>({ autoInvite: true, inviteGroupId: null, list: [], progress: NO_PROGRESS });

  const load = () => api.get('/api/telegram').then(r => {
    setConfigured(r.data.configured); setChannels(r.data.channels); setRecent(r.data.recent);
    if (r.data.bot) setBot(r.data.bot);
    if (r.data.contacts) setContacts(r.data.contacts);
    setTargets(t => t.length ? t.filter(id => r.data.channels.some((c: Channel) => c.id === id && c.enabled)) : r.data.channels.filter((c: Channel) => c.enabled).map((c: Channel) => c.id));
  }).catch(e => setMsg(e?.response?.data?.error || 'Desculpe, não consegui carregar a tela do Telegram. Tente de novo.'));

  // Lote de convites em andamento: acompanha o progresso.
  useEffect(() => {
    if (!contacts.progress.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [contacts.progress.running]);

  async function setContactsCfg(patch: Partial<Pick<Contacts, 'autoInvite' | 'inviteGroupId'>>) {
    try {
      const r = await api.patch('/api/telegram/contacts/settings', patch);
      setContacts(c => ({ ...c, ...r.data }));
      if ('autoInvite' in patch) notify(patch.autoInvite ? 'Quem entrar no bot recebe o convite do grupo sozinho, em até 1 minuto.' : 'Convite automático desligado. Use "Convidar todos" quando quiser.');
      if ('inviteGroupId' in patch) load();
    } catch (e: any) { notify(e?.response?.data?.error || 'Não consegui salvar.', 'error'); }
  }
  /** Em lote: convite do grupo de ofertas para todos os contatos que ainda não receberam (ou só para `ids`). */
  async function inviteAll(ids?: number[], again = false) {
    if (!contacts.inviteGroupId) return notify('Escolha primeiro o grupo de ofertas para onde os contatos vão.', 'error');
    setBusy('invite');
    try {
      const r = await api.post('/api/telegram/contacts/invite', { groupId: contacts.inviteGroupId, contactIds: ids, again });
      if (r.data.queued) notify(`Mandando o convite de "${r.data.groupName}" para ${r.data.queued} contato(s), um por vez. Acompanhe abaixo.`);
      else notify(r.data.total ? `Todos os ${r.data.total} contato(s) já receberam o convite de "${r.data.groupName}".` : 'Ninguém falou com o bot ainda. Mande o link do bot para as pessoas e peça para tocarem em Iniciar.', 'info');
      load();
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui mandar os convites. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }
  const botLink = bot ? `https://t.me/${bot.username}` : '';
  async function copyLink() {
    try { await navigator.clipboard.writeText(botLink); notify('Link do bot copiado. Mande para os seus contatos!'); }
    catch { notify(botLink, 'info'); }
  }
  const shareText = `Oi! Quer receber as melhores ofertas no Telegram? Abra ${botLink} e toque em Iniciar que eu te mando o convite do grupo. 🛍️`;

  useEffect(() => {
    load();
    api.get('/api/integrations/settings').then(r => setTokenMasked(r.data.settings.find((s: any) => s.key === 'TELEGRAM_BOT_TOKEN')?.masked || '')).catch(() => {});
    api.get('/api/me').then(r => setIsAdmin(['MASTER', 'ADMIN'].includes(r.data.user?.role))).catch(() => {});
    api.get('/api/products').then(r => setProducts(r.data.filter((p: Product) => p.active !== false))).catch(() => {});
  }, []);

  // Enquanto houver envio na fila, atualiza a lista sozinha.
  useEffect(() => {
    if (!recent.some(r => r.status === 'PENDING' || r.status === 'PROCESSING')) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [recent]);

  async function saveToken() {
    const v = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(v)) return notify('O token do bot tem o formato 123456789:AAAA... (copie inteiro do @BotFather).', 'error');
    setBusy('token');
    try {
      await api.put('/api/integrations/settings', { TELEGRAM_BOT_TOKEN: v });
      setToken(''); setTokenMasked(`••••${v.slice(-4)}`); setConfigured(true);
      notify('Token do bot salvo com segurança.');
      await testBot();
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui salvar o token. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  async function testBot() {
    setBusy('test'); setBot(null);
    try { const r = await api.post('/api/telegram/test', {}); setBot(r.data.bot); notify(`Bot @${r.data.bot.username} respondeu. Tudo certo!`); }
    catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, o bot não respondeu. Confira o token.', 'error'); }
    finally { setBusy(''); }
  }

  async function discover() {
    setBusy('discover');
    try {
      const r = await api.post('/api/telegram/discover');
      setDiscovered(r.data.chats);
      if (!r.data.chats.length) notify('Nenhum canal apareceu ainda. Adicione o bot como administrador do canal e mande uma mensagem lá, depois tente de novo.', 'info');
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui consultar o bot.', 'error'); }
    finally { setBusy(''); }
  }

  async function addChannel(destination = dest, name = chanName) {
    if (!destination.trim()) return notify('Informe o @nome do canal, o link t.me/... ou o ID numérico.', 'error');
    setBusy('add');
    try {
      const r = await api.post('/api/telegram/channels', { destination, name: name.trim() || undefined });
      setDest(''); setChanName('');
      notify(r.data.warning ? r.data.warning : `Canal "${r.data.channel.name}" cadastrado. ${r.data.info.members ? `${r.data.info.members} membro(s).` : ''}`, r.data.warning ? 'info' : 'ok');
      setDiscovered(d => d ? d.filter(c => String(c.id) !== String(r.data.info.id)) : d);
      setTargets(t => [...t, r.data.channel.id]);
      load();
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui cadastrar esse canal.', 'error'); }
    finally { setBusy(''); }
  }

  async function toggle(c: Channel) {
    try { await api.patch(`/api/channels/${c.id}`, { enabled: !c.enabled }); load(); }
    catch { notify('Não consegui alterar o canal.', 'error'); }
  }
  async function remove(c: Channel) {
    if (!confirm(`Excluir o canal "${c.name}"? Os envios já feitos continuam no histórico.`)) return;
    try { await api.delete(`/api/channels/${c.id}`); notify('Canal excluído.'); load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não consegui excluir.', 'error'); }
  }
  async function setAuto(c: Channel, on: boolean) {
    try { await api.patch(`/api/telegram/channels/${c.id}`, { allAutomations: on }); notify(on ? `"${c.name}" passa a receber as ofertas de todas as automações.` : `"${c.name}" só recebe das automações que o marcarem no passo Canais.`); load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não consegui alterar.', 'error'); }
  }
  async function testChannel(c: Channel) {
    setBusy('ch' + c.id);
    try { const r = await api.post(`/api/telegram/channels/${c.id}/test`); notify(`Mensagem de teste chegou em "${c.name}".`); if (r.data.link) window.open(r.data.link, '_blank', 'noopener'); }
    catch (e: any) { notify(e?.response?.data?.error || `Desculpe, não consegui enviar para "${c.name}".`, 'error'); }
    finally { setBusy(''); }
  }

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter(p => !s || p.title.toLowerCase().includes(s)).slice(0, 60);
  }, [products, q]);
  const togglePick = (id: string) => setPicked(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id]);
  const toggleTarget = (id: string) => setTargets(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id]);

  async function sendProducts() {
    if (!picked.length || !targets.length) return;
    setBusy('send');
    try {
      const r = await api.post('/api/offers/send-now', { productIds: picked, channelIds: targets, fromTo });
      notify(`${r.data.count} envio(s) na fila para o Telegram. Acompanhe abaixo.`);
      setPicked([]); load();
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui colocar na fila. Tente de novo.', 'error'); }
    finally { setBusy(''); }
  }

  async function sendFree() {
    if (!freeText.trim() || !targets.length) return;
    setBusy('free');
    try {
      const r = await api.post('/api/telegram/message', { channelIds: targets, text: freeText, imageUrl: freeImage.trim() || undefined });
      notify(`Mensagem na fila para ${r.data.count} canal(is).`);
      setFreeText(''); setFreeImage(''); load();
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui enviar a mensagem.', 'error'); }
    finally { setBusy(''); }
  }

  const active = channels.filter(c => c.enabled);
  const queued = recent.filter(r => r.status === 'PENDING' || r.status === 'PROCESSING').length;

  return <section className="page">
    <h1>Telegram</h1>
    <p>Mande as promoções para os seus canais e grupos do Telegram, igual aos grupos do WhatsApp. Um bot seu publica lá. Canal cadastrado aqui já nasce no modo automático: recebe as ofertas de todas as automações (com a categoria, o horário e o intervalo de cada uma) e o listão de cupons. Para uma categoria e um horário só do Telegram, use o atalho "Criar automação" do canal.</p>
    {msg && <p className="inline-msg">{msg}</p>}

    <div className="card">
      <div className="card-head"><div><SendHorizontal size={22} /><h3>Bot do Telegram</h3></div>
        <span className={`badge ${configured ? 'badge-on' : configured === false ? 'badge-off' : 'badge-load'}`}>{configured ? <><CheckCircle2 size={15} /> Token salvo</> : configured === false ? 'Sem token' : 'Verificando...'}</span></div>
      {!configured && <div className="ml-steps"><b>Leva 3 minutos:</b><ol>
        <li>No Telegram, abra o <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, mande <code>/newbot</code>, escolha um nome e um usuário terminado em <code>bot</code>.</li>
        <li>Copie o <b>token</b> que ele devolve (formato <code>123456789:AAAA...</code>) e cole abaixo.</li>
        <li>No seu canal, em Administradores, adicione o bot com permissão de <b>Publicar mensagens</b>. Em grupo, basta adicioná-lo como membro.</li>
        <li>Cadastre o canal no quadro seguinte pelo @nome, pelo link ou pelo ID. Pronto: ele passa a receber as ofertas.</li>
      </ol></div>}
      {isAdmin ? <div className="form-row form-row-tight">
        <input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={tokenMasked ? `Token salvo (${tokenMasked}). Cole outro para trocar.` : 'Cole aqui o token do @BotFather'} />
        <button className="primary" disabled={busy === 'token' || !token.trim()} onClick={saveToken}><Plus size={16} /> {busy === 'token' ? 'Salvando...' : 'Salvar token'}</button>
        <button className="outline" disabled={busy === 'test' || !configured} onClick={testBot}><RefreshCw size={16} /> {busy === 'test' ? 'Testando...' : 'Testar bot'}</button>
      </div> : <p className="hint" style={{ margin: 0 }}>Só administradores salvam o token do bot. Peça a um administrador para configurar.</p>}
      {bot && <p className="hint">Bot conectado: <b>@{bot.username}</b> ({bot.name}). Coloque esse bot como administrador dos canais onde as ofertas devem sair.</p>}
    </div>

    <div className="card">
      <div className="card-head"><div><Send size={22} /><h3>Canais e grupos</h3></div><span className="badge badge-off">{active.length} ativo(s)</span></div>
      <div className="form-row form-row-tight">
        <input value={dest} onChange={e => setDest(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addChannel(); }} placeholder="@meucanal, t.me/meucanal ou -1001234567890" />
        <input value={chanName} onChange={e => setChanName(e.target.value)} placeholder="Apelido no painel (opcional)" style={{ maxWidth: 260 }} />
        <button className="primary" disabled={busy === 'add' || !configured} onClick={() => addChannel()}><Plus size={16} /> {busy === 'add' ? 'Conferindo...' : 'Cadastrar canal'}</button>
        <button className="outline" disabled={busy === 'discover' || !configured} onClick={discover} title="Lista os canais e grupos em que o bot foi adicionado recentemente"><Search size={16} /> {busy === 'discover' ? 'Procurando...' : 'Descobrir canais do bot'}</button>
      </div>
      <p className="hint">Canal privado não tem @nome: use "Descobrir canais do bot" logo depois de adicionar o bot nele (ou mande uma mensagem no canal) para pegar o ID.</p>
      {discovered && discovered.filter(c => c.type !== 'private').length > 0 && <div className="tg-discover">{discovered.filter(c => c.type !== 'private').map(c => <div className="user-row" key={c.id}><div className="user-main"><b>{c.title}</b><small>{c.type === 'channel' ? 'Canal' : 'Grupo'} · {c.username ? `@${c.username}` : `ID ${c.id}`}</small></div>
        {channels.some(x => x.destination === (c.username ? `@${c.username}` : String(c.id))) ? <span className="badge badge-on">Já cadastrado</span> : <button className="outline" disabled={busy === 'add'} onClick={() => addChannel(c.username ? `@${c.username}` : String(c.id), c.title)}><Plus size={16} /> Cadastrar</button>}</div>)}</div>}
      {channels.length ? <div className="list-grid" style={{ marginTop: 16 }}>{channels.map(c => <div className="card tg-channel" key={c.id}>
        <div className="card-head"><div><SendHorizontal size={20} /><h3>{c.name}</h3></div><span className={`badge ${c.enabled ? 'badge-on' : 'badge-off'}`}>{c.enabled ? 'Ativo' : 'Pausado'}</span></div>
        <p className="muted">{chatLink(c.destination) ? <a href={chatLink(c.destination)!} target="_blank" rel="noreferrer">{c.destination}</a> : `ID ${c.destination}`}</p>
        <label className="check-line" style={{ marginTop: 4, fontSize: 14 }} title="Ligado: recebe as ofertas de todas as automações e o listão de cupons, sem precisar marcar este canal em cada uma. Desligado: só das automações que o escolherem no passo Canais.">
          <input type="checkbox" checked={c.allAutomations} onChange={e => setAuto(c, e.target.checked)} /><span>Automático: ofertas de todas as automações</span>
        </label>
        <Link className="link-btn" style={{ marginTop: 6, padding: 0, textAlign: 'left' }} to={`/automations/new?channel=${c.id}&name=${encodeURIComponent('Telegram ' + c.name)}`} title="Abre Nova automação já com este canal marcado: escolha a categoria, os termos, o horário e o intervalo"><Zap size={14} style={{ verticalAlign: -2 }} /> Criar automação com categoria e horário só para este canal</Link>
        <div className="card-actions">
          <button className="outline" onClick={() => toggle(c)}><Power size={16} /> {c.enabled ? 'Pausar' : 'Ativar'}</button>
          <button className="outline" disabled={busy === 'ch' + c.id} onClick={() => testChannel(c)}><Send size={16} /> {busy === 'ch' + c.id ? 'Enviando...' : 'Testar'}</button>
          <button className="icon-btn" title="Excluir canal" onClick={() => remove(c)}><Trash2 size={18} /></button>
        </div>
      </div>)}</div> : <p className="hint">Nenhum canal do Telegram cadastrado ainda.</p>}
    </div>

    <div className="card">
      <div className="card-head"><div><Users size={22} /><h3>Contatos → grupo de ofertas</h3></div><span className="badge badge-off">{contacts.list.length} contato(s) · {contacts.list.filter(c => c.invitedAt).length} convidado(s)</span></div>
      <p className="hint" style={{ marginTop: 0 }}>Para colocar gente no grupo de ofertas em lote. O Telegram não deixa um bot inserir ninguém num grupo, e o bot só fala com quem abriu a conversa com ele: mande o link do bot abaixo para os seus contatos (ou cole nos seus grupos do WhatsApp). Quem tocar em <b>Iniciar</b> aparece aqui e recebe o convite do grupo, sozinho e em lote. Oferta nenhuma vai no privado: as promoções saem só no grupo.</p>
      {configured && (bot ? <div className="form-row form-row-tight">
        <input readOnly value={botLink} onFocus={e => e.target.select()} title="Link do seu bot: quem abrir e tocar em Iniciar vira contato" />
        <button className="outline" onClick={copyLink}><Copy size={16} /> Copiar link do bot</button>
        <a className="outline tg-link" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer" title="Abre o WhatsApp com o convite pronto para você escolher o contato ou grupo"><SendHorizontal size={16} /> Mandar pelo WhatsApp</a>
      </div> : <p className="hint">Clique em "Testar bot" acima para carregar o link do bot.</p>)}
      <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
        <select value={contacts.inviteGroupId || ''} onChange={e => setContactsCfg({ inviteGroupId: e.target.value || null })} title="Grupo ou canal do Telegram cujo convite os contatos recebem" style={{ maxWidth: 320 }}>
          <option value="">Escolha o grupo de ofertas...</option>
          {channels.map(c => <option key={c.id} value={c.id}>{c.name} ({c.destination})</option>)}
        </select>
        <label className="check-line" style={{ marginTop: 0, fontSize: 14, flex: 'none' }} title="A cada minuto o robô lê quem tocou em Iniciar no bot e manda o convite do grupo na hora, sem você precisar clicar."><input type="checkbox" checked={contacts.autoInvite} onChange={e => setContactsCfg({ autoInvite: e.target.checked })} /><span>Convidar sozinho quem entrar no bot</span></label>
        <button className="primary" disabled={busy === 'invite' || !configured || !contacts.inviteGroupId || contacts.progress.running} onClick={() => inviteAll()} title="Manda agora o convite do grupo para todos os contatos que ainda não receberam"><UserPlus size={16} /> {busy === 'invite' ? 'Preparando...' : `Convidar todos para o grupo (${contacts.list.filter(c => !c.invitedAt).length})`}</button>
      </div>
      {!channels.length && <p className="hint">Cadastre primeiro o grupo (ou canal) de ofertas no quadro acima; o bot precisa ser administrador dele com permissão de convidar por link.</p>}
      {(contacts.progress.running || contacts.progress.total > 0) && <p className={contacts.progress.running ? 'hint' : 'hint'} style={{ marginTop: 8 }}>
        {contacts.progress.running ? <><RefreshCw size={14} style={{ verticalAlign: -2 }} /> Mandando convites de "{contacts.progress.groupName}": {contacts.progress.sent + contacts.progress.failed} de {contacts.progress.total}{contacts.progress.failed ? ` (${contacts.progress.failed} falha(s))` : ''}...</>
          : <>Último lote para "{contacts.progress.groupName}": {contacts.progress.sent} convite(s) enviado(s){contacts.progress.failed ? `, ${contacts.progress.failed} falha(s)` : ''}{contacts.progress.finishedAt ? ` · ${when(contacts.progress.finishedAt)}` : ''}.</>}
        {contacts.progress.errors.length > 0 && <small className="log-err" style={{ display: 'block' }}>{contacts.progress.errors.slice(0, 3).join(' · ')}</small>}
      </p>}
      {contacts.list.length ? <div className="tg-discover">{contacts.list.map(c => <div className="user-row" key={c.id}>
        <div className="user-main"><b>{c.title}</b><small>{c.username ? <a href={`https://t.me/${c.username}`} target="_blank" rel="noreferrer">@{c.username}</a> : `ID ${c.id}`} · entrou no bot {when(c.seenAt)}</small></div>
        {c.invitedAt ? <span className="badge badge-on" title="Já recebeu o convite do grupo escolhido"><CheckCircle2 size={14} /> Convidado {when(c.invitedAt)}</span> : <span className="badge badge-ready">Aguardando convite</span>}
        <button className="outline" disabled={busy === 'invite' || !contacts.inviteGroupId || contacts.progress.running} onClick={() => inviteAll([c.id], true)} title={c.invitedAt ? 'Manda o convite de novo' : 'Manda o convite do grupo só para este contato'}><UserPlus size={15} /> {c.invitedAt ? 'Reenviar' : 'Convidar'}</button>
      </div>)}</div> : <p className="hint">Ninguém falou com o bot ainda. Mande o link do bot e peça para tocar em Iniciar: a pessoa aparece aqui em até 1 minuto.</p>}
    </div>

    <div className="card">
      <div className="card-head"><div><Send size={22} /><h3>Enviar promoção agora</h3></div></div>
      <div className="send-bar-groups" style={{ marginBottom: 12 }}>
        <span className="send-bar-label"><SendHorizontal size={16} /> Para</span>
        {active.length ? active.map(c => <button key={c.id} className={`chip-toggle ${targets.includes(c.id) ? 'on' : ''}`} onClick={() => toggleTarget(c.id)}>{c.name}</button>) : <span className="hint" style={{ margin: 0 }}>Cadastre e ative um canal acima.</span>}
      </div>
      <div className="form-row form-row-tight">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar nos seus produtos (nome)" />
        <label className="check-line" style={{ marginTop: 0, fontSize: 13.5, flex: 'none' }} title="Mostra a linha DE R$ 199,90 acima do preço"><input type="checkbox" checked={fromTo} onChange={e => setFromTo(e.target.checked)} /><span>De X por Y</span></label>
        <button className="primary" disabled={busy === 'send' || !picked.length || !targets.length} onClick={sendProducts}><Send size={16} /> {busy === 'send' ? 'Enviando...' : `Enviar ${picked.length} produto(s) para ${targets.length} canal(is)`}</button>
      </div>
      <p className="hint">Os produtos vêm da tela Produtos (busca das automações e Capturar ofertas). Vai com foto e a mensagem no modelo padrão, com negrito de verdade no Telegram.</p>
      {filtered.length ? <div className="preview-grid">{filtered.map(p => { const on = picked.includes(p.id); return <div className={`preview-card tg-pick ${on ? 'sel' : ''}`} key={p.id} onClick={() => togglePick(p.id)} role="button">
        {p.imageUrl ? <img src={p.imageUrl} alt={p.title} loading="lazy" /> : <div className="preview-noimg">Sem foto</div>}
        <h4>{p.title}</h4>
        <div className="preview-meta"><strong>{p.price != null ? brl(Number(p.price)) : ''}</strong>{p.discountPercent ? <span className="badge badge-on">{p.discountPercent}% OFF</span> : null}</div>
        {on && <span className="badge badge-on tg-check"><CheckCircle2 size={14} /> Selecionado</span>}
      </div>; })}</div> : <p className="hint">{products.length ? 'Nenhum produto com esse nome.' : 'Nenhum produto cadastrado. Importe em Capturar ofertas ou rode uma automação.'}</p>}
      {products.length > 60 && filtered.length === 60 && <p className="hint">Mostrando os 60 mais recentes. Use a busca para achar outros.</p>}
    </div>

    <div className="card">
      <div className="card-head"><div><Send size={22} /><h3>Mensagem avulsa</h3></div></div>
      <textarea value={freeText} onChange={e => setFreeText(e.target.value)} placeholder={'Texto livre para os canais marcados acima. Use *asteriscos* para negrito e ~til~ para riscar.\nEx.: 🔥 *CUPOM NOVO* 20% OFF em tudo hoje!'} />
      <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
        <input value={freeImage} onChange={e => setFreeImage(e.target.value)} placeholder="Link de uma foto (opcional, http...)" />
        <button className="primary" disabled={busy === 'free' || !freeText.trim() || !targets.length} onClick={sendFree}><Send size={16} /> {busy === 'free' ? 'Enviando...' : `Enviar para ${targets.length} canal(is)`}</button>
      </div>
    </div>

    <div className="card">
      <div className="card-head"><div><RefreshCw size={22} /><h3>Últimos envios para o Telegram</h3></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{queued > 0 && <span className="badge badge-ready">{queued} na fila</span>}<button className="outline" onClick={load}><RefreshCw size={16} /> Atualizar</button></div></div>
      {recent.length ? <div className="tg-recent">{recent.map(r => <div className="user-row" key={r.id}>
        {r.imageUrl ? <img className="tg-thumb" src={r.imageUrl} alt="" loading="lazy" /> : <div className="tg-thumb tg-thumb-empty" />}
        <div className="user-main"><b>{r.title}</b><small>{r.channel.name} · {when(r.createdAt)}{r.price != null ? ` · ${brl(r.price)}` : ''}</small>{r.status === 'FAILED' && r.error && <small className="log-err">{r.error}</small>}</div>
        <span className={`badge ${stClass(r.status)}`}>{stLabel(r.status)}</span>
        {r.link && <a className="outline tg-link" href={r.link} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Ver no Telegram</a>}
      </div>)}</div> : <p className="hint">Nada enviado ainda. Escolha produtos acima e clique em Enviar.</p>}
    </div>
  </section>;
}
