import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Plus, Power, RefreshCw, Search, Send, SendHorizontal, Trash2, Zap } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';
import { brl } from './money';

/**
 * Tela "Telegram" (pedido do usuário em 2026-10-16): manda as promoções para canais e grupos do Telegram.
 * Funciona com um bot criado no @BotFather: o token fica salvo criptografado (TELEGRAM_BOT_TOKEN) e cada canal
 * onde o bot é administrador vira um canal do tipo TELEGRAM, que as automações, o Capturar ofertas e o listão
 * de cupons também podem usar. Aqui dá para cadastrar os canais, testar e disparar produtos na hora.
 */

type Channel = { id: string; name: string; destination: string; enabled: boolean; allAutomations: boolean };
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

  const load = () => api.get('/api/telegram').then(r => {
    setConfigured(r.data.configured); setChannels(r.data.channels); setRecent(r.data.recent);
    setTargets(t => t.length ? t.filter(id => r.data.channels.some((c: Channel) => c.id === id && c.enabled)) : r.data.channels.filter((c: Channel) => c.enabled).map((c: Channel) => c.id));
  }).catch(e => setMsg(e?.response?.data?.error || 'Desculpe, não consegui carregar a tela do Telegram. Tente de novo.'));

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
      {discovered && discovered.length > 0 && <div className="tg-discover">{discovered.map(c => <div className="user-row" key={c.id}><div className="user-main"><b>{c.title}</b><small>{c.type === 'channel' ? 'Canal' : 'Grupo'} · {c.username ? `@${c.username}` : `ID ${c.id}`}</small></div>
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
