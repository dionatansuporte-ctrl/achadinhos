import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, LogOut, Pause, Play, RefreshCw, Smartphone, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';

/**
 * Tela "Telegram: contatos nos grupos" (pedido do usuário em 2026-10-16): coloca contatos dentro de um grupo do Telegram
 * pela conta do próprio usuário, porque o bot não consegue. Login por telefone + código do app (+ senha de duas etapas).
 * Origem: telefones colados, outro grupo do Telegram, um grupo do WhatsApp conectado ou os clientes do WhatsApp.
 * Ritmo travado no servidor (mín. 20 s entre pessoas, máx. 100 por dia) para o Telegram não suspender a conta.
 */

type Account = { status: 'disconnected' | 'connecting' | 'code_sent' | 'password_needed' | 'connected' | 'error'; phone: string | null; me: { name: string; username: string | null; phone: string | null } | null; error: string | null; hasApi: boolean };
type TgGroup = { id: string; title: string; username: string | null; members: number | null; kind: string; canInvite: boolean };
type WaGroup = { id: string; name: string; participants: number };
type Job = { toId: string; toName: string; fromLabel: string; pauseSec: number; dailyLimit: number; total: number; done: number; added: number; noTelegram: number; privacy: number; already: number; failed: number; left: number; running: boolean; stopped: boolean; error: string | null; waitingUntil: string | null; startedAt: string; finishedAt: string | null; log: { name: string; result: string; at: string }[] };
type Copy = { addedToday: number; maxDaily: number; minPauseSec: number; jobs: Job[] };
type SourceType = 'phones' | 'telegram' | 'whatsapp' | 'customers';

const when = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const parsePhones = (text: string) => [...new Set(text.split(/[\s,;]+/).map(t => t.replace(/\D/g, '')).filter(d => d.length >= 10 && d.length <= 15))];

export default function TelegramGroups() {
  const [account, setAccount] = useState<Account | null>(null);
  const [copy, setCopy] = useState<Copy>({ addedToday: 0, maxDaily: 100, minPauseSec: 20, jobs: [] });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [groups, setGroups] = useState<TgGroup[] | null>(null);
  const [waGroups, setWaGroups] = useState<WaGroup[]>([]);
  const [to, setTo] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('phones');
  const [phonesText, setPhonesText] = useState('');
  const [fromTg, setFromTg] = useState('');
  const [fromWa, setFromWa] = useState('');
  const [pauseSec, setPauseSec] = useState(30);
  const [dailyLimit, setDailyLimit] = useState(40);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.get('/api/telegram/account').then(r => { setAccount(r.data.account); setCopy(r.data.copy); })
    .catch(e => setMsg(e?.response?.data?.error || 'Desculpe, não consegui carregar. Só administradores usam esta tela.'));
  useEffect(() => { load(); api.get('/api/whatsapp/groups').then(r => setWaGroups(r.data)).catch(() => {}); }, []);
  // Enquanto alguma importação roda, atualiza sozinha.
  useEffect(() => {
    if (!copy.jobs.some(j => j.running)) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [copy.jobs.some(j => j.running)]);
  useEffect(() => { if (account?.status === 'connected' && groups === null) loadGroups(); }, [account?.status]);

  async function loadGroups() {
    setBusy('groups');
    try { const r = await api.get('/api/telegram/account/groups'); setGroups(r.data.groups); if (!to && r.data.groups.length) setTo(r.data.groups.find((g: TgGroup) => g.canInvite)?.id || ''); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não consegui listar os seus grupos do Telegram.', 'error'); setGroups([]); }
    finally { setBusy(''); }
  }
  async function login() {
    setBusy('login');
    try { const r = await api.post('/api/telegram/account/login', { phone }); setAccount(r.data.account); notify(r.data.viaApp ? 'Código enviado para o seu app do Telegram (conversa "Telegram").' : 'Código enviado por SMS.'); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não consegui pedir o código.', 'error'); }
    finally { setBusy(''); }
  }
  async function sendCode() {
    setBusy('code');
    try {
      const r = await api.post('/api/telegram/account/code', { code, password: password || undefined });
      setAccount(r.data.account);
      if (r.data.passwordNeeded) notify('Sua conta tem senha de duas etapas. Digite a senha e confirme.', 'info');
      else { notify(`Conectado como ${r.data.me?.name}. Tudo certo!`); setCode(''); setPassword(''); }
    } catch (e: any) { notify(e?.response?.data?.error || 'Não consegui entrar.', 'error'); }
    finally { setBusy(''); }
  }
  async function logout() {
    if (!confirm('Desconectar a sua conta do Telegram deste sistema? As importações paradas continuam na lista.')) return;
    try { const r = await api.post('/api/telegram/account/logout'); setAccount(r.data.account); setGroups(null); notify('Conta desconectada.'); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não consegui desconectar.', 'error'); }
  }

  const phones = parsePhones(phonesText);
  const canStart = !!to && (sourceType === 'phones' ? phones.length > 0 : sourceType === 'telegram' ? !!fromTg && fromTg !== to : sourceType === 'whatsapp' ? !!fromWa : true);
  async function start() {
    const source = sourceType === 'phones' ? { type: 'phones', phones } : sourceType === 'telegram' ? { type: 'telegram', groupId: fromTg } : sourceType === 'whatsapp' ? { type: 'whatsapp', groupId: fromWa } : { type: 'customers' };
    setBusy('start');
    try {
      const r = await api.post('/api/telegram/account/copy', { to, source, pauseSec, dailyLimit });
      setCopy(r.data); notify('Importação começou. Uma pessoa por vez, acompanhe abaixo.');
      if (sourceType === 'phones') setPhonesText('');
    } catch (e: any) { notify(e?.response?.data?.error || 'Desculpe, não consegui começar a importação.', 'error'); }
    finally { setBusy(''); }
  }
  const jobAction = (path: string, body: any, ok: string) => api.post(`/api/telegram/account/copy/${path}`, body).then(r => { setCopy(r.data); notify(ok); }).catch(e => notify(e?.response?.data?.error || 'Não consegui.', 'error'));
  const removeJob = (j: Job) => { if (confirm(`Tirar da lista a importação para "${j.toName}"? Quem já entrou continua no grupo.`)) api.delete(`/api/telegram/account/copy/${encodeURIComponent(j.toId)}`).then(r => setCopy(r.data)).catch(e => notify(e?.response?.data?.error || 'Não consegui.', 'error')); };

  const connected = account?.status === 'connected';
  const targets = (groups || []).filter(g => g.canInvite);

  return <section className="page">
    <h1>Telegram: contatos nos grupos</h1>
    <p>Coloca contatos dentro dos seus grupos do Telegram pela <b>sua conta</b> (o bot da tela <Link to="/telegram">Telegram</Link> não consegue fazer isso). Dá para colar telefones, copiar os membros de um grupo do Telegram para outro, puxar os membros de um grupo do WhatsApp ou os seus clientes.</p>
    <p className="hint" style={{ marginTop: -6 }}>⚠️ O Telegram suspende contas que adicionam gente em excesso, e muita gente tem a privacidade "só contatos podem me adicionar" (essas não entram). Por isso o ritmo é travado: uma pessoa por vez, pelo menos {copy.minPauseSec} s entre elas e no máximo {copy.maxDaily} por dia. Prefira usar um número secundário.</p>
    {msg && <p className="inline-msg">{msg}</p>}

    <div className="card">
      <div className="card-head"><div><Smartphone size={22} /><h3>Sua conta do Telegram</h3></div>
        <span className={`badge ${connected ? 'badge-on' : account?.status === 'error' ? 'badge-off' : 'badge-load'}`}>{connected ? <><CheckCircle2 size={15} /> Conectada</> : account?.status === 'connecting' ? 'Conectando...' : account?.status === 'code_sent' ? 'Aguardando código' : account?.status === 'password_needed' ? 'Aguardando senha' : account?.status === 'error' ? 'Erro' : 'Desconectada'}</span></div>
      {account && !account.hasApi && <div className="ml-steps"><b>Antes de conectar (uma vez só):</b><ol>
        <li>Entre em <a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a> com o seu número e abra <b>API development tools</b>.</li>
        <li>Crie um aplicativo (qualquer nome) e copie o <b>api_id</b> e o <b>api_hash</b>.</li>
        <li>Cole os dois em <Link to="/settings">Configurações → Telegram</Link> e volte aqui.</li>
      </ol></div>}
      {account?.error && <p className="inline-msg">{account.error}</p>}
      {connected ? <div className="form-row form-row-tight">
        <p className="hint" style={{ margin: 0, flex: 1 }}>Conectado como <b>{account!.me?.name}</b>{account!.me?.username ? ` (@${account!.me.username})` : ''}{account!.me?.phone ? ` · ${account!.me.phone}` : ''}.</p>
        <button className="outline" onClick={logout}><LogOut size={16} /> Desconectar</button>
      </div> : account?.status === 'code_sent' || account?.status === 'password_needed' ? <div className="form-row form-row-tight">
        {account.status === 'code_sent' && <input value={code} onChange={e => setCode(e.target.value)} placeholder="Código que chegou no Telegram" style={{ maxWidth: 240 }} autoFocus />}
        {account.status === 'password_needed' && <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Senha de duas etapas" style={{ maxWidth: 260 }} autoFocus />}
        <button className="primary" disabled={busy === 'code' || (account.status === 'code_sent' ? !code.trim() : !password)} onClick={sendCode}><CheckCircle2 size={16} /> {busy === 'code' ? 'Entrando...' : 'Confirmar'}</button>
        <button className="outline" disabled={busy === 'login'} onClick={login}>Pedir outro código</button>
      </div> : <div className="form-row form-row-tight">
        <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="Telefone com DDI e DDD, ex.: 5544999999999" style={{ maxWidth: 320 }} />
        <button className="primary" disabled={busy === 'login' || !account?.hasApi || phone.length < 10} onClick={login}><Smartphone size={16} /> {busy === 'login' ? 'Pedindo código...' : 'Conectar'}</button>
      </div>}
    </div>

    {connected && <div className="card">
      <div className="card-head"><div><UserPlus size={22} /><h3>Nova importação</h3></div><span className="badge badge-off">{copy.addedToday} de {copy.maxDaily} hoje</span></div>
      <label>Grupo de destino (onde as pessoas entram)</label>
      <div className="form-row form-row-tight">
        <select value={to} onChange={e => setTo(e.target.value)} style={{ maxWidth: 420 }}>
          <option value="">{groups === null ? 'Carregando os seus grupos...' : targets.length ? 'Escolha o grupo...' : 'Nenhum grupo em que você possa adicionar pessoas'}</option>
          {targets.map(g => <option key={g.id} value={g.id}>{g.title}{g.members != null ? ` · ${g.members} membros` : ''}{g.kind === 'canal' ? ' (canal)' : ''}</option>)}
        </select>
        <button className="outline" disabled={busy === 'groups'} onClick={loadGroups}><RefreshCw size={16} /> {busy === 'groups' ? 'Atualizando...' : 'Atualizar grupos'}</button>
      </div>
      {groups && groups.some(g => !g.canInvite) && <p className="hint">Grupos em que você não é administrador com "Adicionar membros" ficam fora da lista.</p>}
      <label style={{ marginTop: 12 }}>De onde vêm as pessoas</label>
      <div className="choice-grid choice-grid-tight" style={{ maxWidth: 720 }}>
        {([['phones', 'Telefones colados'], ['telegram', 'Outro grupo do Telegram'], ['whatsapp', 'Grupo do WhatsApp'], ['customers', 'Clientes do WhatsApp']] as [SourceType, string][]).map(([v, l]) => <button key={v} type="button" className={sourceType === v ? 'chosen' : ''} onClick={() => setSourceType(v)}>{l}</button>)}
      </div>
      {sourceType === 'phones' && <>
        <textarea value={phonesText} onChange={e => setPhonesText(e.target.value)} placeholder={'Cole os telefones (um por linha, ou separados por vírgula), com DDI e DDD.\nEx.: 5544999999999'} style={{ marginTop: 10 }} />
        <p className="hint">{phones.length} telefone(s) válido(s). Cada número é salvo na agenda do seu Telegram para descobrir quem tem conta; quem não tem Telegram aparece como "sem Telegram".</p>
      </>}
      {sourceType === 'telegram' && <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
        <select value={fromTg} onChange={e => setFromTg(e.target.value)} style={{ maxWidth: 420 }}>
          <option value="">Grupo de origem...</option>
          {(groups || []).filter(g => g.id !== to).map(g => <option key={g.id} value={g.id}>{g.title}{g.members != null ? ` · ${g.members} membros` : ''}</option>)}
        </select>
        <span className="hint" style={{ margin: 0 }}>Copia os membros desse grupo (precisa que o Telegram mostre a lista de membros para a sua conta).</span>
      </div>}
      {sourceType === 'whatsapp' && <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
        <select value={fromWa} onChange={e => setFromWa(e.target.value)} style={{ maxWidth: 420 }}>
          <option value="">{waGroups.length ? 'Grupo do WhatsApp...' : 'Nenhum WhatsApp conectado'}</option>
          {waGroups.map(g => <option key={g.id} value={g.id}>{g.name} · {g.participants} membros</option>)}
        </select>
        <span className="hint" style={{ margin: 0 }}>Usa os telefones dos membros do grupo do WhatsApp.</span>
      </div>}
      {sourceType === 'customers' && <p className="hint" style={{ marginTop: 10 }}>Usa os telefones dos clientes da tela Clientes (sem os bloqueados e sem quem pediu "chega de oferta").</p>}
      <div className="search-opts" style={{ marginTop: 12 }}>
        <div><label>Pausa entre pessoas: {pauseSec} s</label><input type="range" min={copy.minPauseSec} max={300} step={5} value={pauseSec} onChange={e => setPauseSec(Number(e.target.value))} /></div>
        <div><label>Limite por dia: {dailyLimit}</label><input type="range" min={1} max={copy.maxDaily} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))} /></div>
      </div>
      <p className="hint">Quem já está no grupo ou já foi adicionado por aqui é pulado. Ao bater o limite do dia, a importação espera a meia-noite e continua sozinha. Se o Telegram pedir para esperar, ela espera e segue.</p>
      <button className="primary" disabled={busy === 'start' || !canStart} onClick={start}><UserPlus size={16} /> {busy === 'start' ? 'Preparando...' : 'Começar a adicionar'}</button>
    </div>}

    <div className="card">
      <div className="card-head"><div><Users size={22} /><h3>Importações</h3></div><button className="outline" onClick={load}><RefreshCw size={16} /> Atualizar</button></div>
      {copy.jobs.length ? copy.jobs.map(j => <div className="card" key={j.toId} style={{ marginBottom: 12 }}>
        <div className="card-head"><div><UserPlus size={20} /><h3>{j.toName}</h3></div>
          <span className={`badge ${j.running ? 'badge-ready' : j.error ? 'badge-off' : j.left ? 'badge-off' : 'badge-on'}`}>{j.running ? (j.waitingUntil ? `Esperando até ${when(j.waitingUntil)}` : 'Adicionando...') : j.error ? 'Parada por erro' : j.left ? 'Parada' : 'Concluída'}</span></div>
        <p className="muted">Origem: {j.fromLabel} · começou {when(j.startedAt)} · {j.pauseSec} s entre pessoas, {j.dailyLimit} por dia</p>
        <p style={{ margin: '4px 0' }}><b>{j.done} de {j.total}</b> processados · <b>{j.added}</b> adicionados · {j.already} já estavam · {j.privacy} com privacidade · {j.noTelegram} sem Telegram · {j.failed} falhas{j.left ? ` · faltam ${j.left}` : ''}</p>
        {j.error && <p className="inline-msg">{j.error}</p>}
        <div className="card-actions">
          {j.running ? <button className="outline" onClick={() => jobAction('stop', { to: j.toId }, 'Parando: a pessoa da vez termina e nada mais é adicionado.')}><Pause size={16} /> Parar</button>
            : j.left > 0 ? <button className="primary" onClick={() => jobAction('resume', { to: j.toId, pauseSec, dailyLimit }, 'Continuando de onde parou.')}><Play size={16} /> Continuar ({j.left} faltam)</button> : null}
          {!j.running && <button className="icon-btn" title="Tirar da lista" onClick={() => removeJob(j)}><Trash2 size={18} /></button>}
        </div>
        {j.log.length > 0 && <details style={{ marginTop: 8 }}><summary className="hint" style={{ cursor: 'pointer' }}>Últimos resultados ({j.log.length})</summary>
          <div className="tg-discover">{j.log.map((l, i) => <div className="user-row" key={i} style={{ padding: '8px 12px' }}><div className="user-main"><b>{l.name}</b><small>{l.result} · {when(l.at)}</small></div></div>)}</div></details>}
      </div>) : <p className="hint">Nenhuma importação ainda.</p>}
    </div>
  </section>;
}
