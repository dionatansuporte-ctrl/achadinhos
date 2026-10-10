import { useEffect, useRef, useState } from 'react';
import { Copy, MessageCircle, Power, QrCode, RefreshCw, Send, Trash2, Ban, History, Bot, Clock3, Store, UserPlus, Users, Square, FileUp } from 'lucide-react';
import { api } from './api';
import { parsePhones } from './phones';
import { notify } from './notify';
import { MKTS, mktName, mktIcon, type Mkt } from './marketplaces';

/**
 * Clientes: atendimento no privado do WhatsApp.
 * O usuário divulga o link wa.me; o cliente escreve o que procura e recebe as ofertas só ele.
 * Aqui ficam a configuração (ligar/desligar, limite por tempo, cupons, boas-vindas), o link com
 * QR code e a lista de quem já falou com o robô, com histórico e envio manual por cliente.
 * Também o convite para o grupo de ofertas (2026-10-08): manda o link de um grupo no privado dos
 * clientes marcados ou de telefones avulsos.
 */

type Bot = { enabled: boolean; everyMinutes: number; maxOffers: number; marketplaces: Mkt[]; askMarketplace: boolean; sendCoupons: boolean; welcomeText?: string | null; linkText?: string | null; inviteText?: string | null };
type Customer = { id: string; jid: string; phone?: string | null; name?: string | null; givenName?: string | null; notes?: string | null; blocked: boolean; optedOut: boolean; requestCount: number; lastRequestAt?: string | null; firstSeenAt: string; lastSeenAt: string; lastRequest?: { keyword?: string | null; status: string; createdAt: string; text: string } | null };
type Payload = { bot: Bot; link: string | null; waConnected: boolean; waNumber: string | null; customers: Customer[] };
type Group = { id: string; name: string; participants: number };
type Invite = { groupName: string; total: number; sent: number; failed: string[]; skipped: number; already?: number; running: boolean; stopped?: boolean; error: string | null; left?: number; waitingUntil?: string | null; dailyLimit?: number; pauseSec?: number; sessionPhone?: string | null };
type WaNumber = { id: string; main: boolean; disposable?: boolean; status: string; me?: { id: string; name?: string } | null };
const VIA_KEY = 'convite-numero';
// Uma fila e uma contagem por número (chave = id do número que manda).
type InviteState = { counts: Record<string, number>; jobs: Record<string, Invite> };
// Pausas entre um convite e outro; quanto maior, menor o risco de o WhatsApp bloquear o número.
const PAUSES = [30, 60, 120, 300, 600, 900, 1800, 3600];
const fmtPause = (s: number) => s < 60 ? `${s} segundos` : s === 60 ? '1 minuto' : s < 3600 ? `${s / 60} minutos` : '1 hora';
/** Tempo aproximado para a fila terminar, respeitando o limite por dia. */
function fmtPlan(people: number, pauseSec: number, limit: number, usedToday: number) {
  const room = Math.max(0, limit - usedToday);
  if (people <= room) { const min = Math.ceil(((people - 1) * pauseSec) / 60); return min < 1 ? 'menos de 1 minuto' : min < 60 ? `uns ${min} minuto(s)` : `umas ${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`; }
  const moreDays = Math.ceil((people - room) / limit);
  return `${moreDays + (room ? 1 : 0)} dia(s), porque o limite é de ${limit} por dia: ${room ? `hoje saem ${room}, ` : 'hoje o limite já acabou, '}depois ${limit} por dia, continuando sozinho a cada virada do dia`;
}

// {nome} vira ", Fulano" (ou some, se o nome não for conhecido); {grupo} e {link} são trocados pelo servidor.
// Modelo pedido pelo usuário em 2026-10-09. No WhatsApp o negrito é *texto* (um asterisco de cada lado).
const DEFAULT_INVITE = '👋 Oi{nome}! Tudo bem? 😊\n\n🛍️ Conheça o grupo *{grupo}* e receba ofertas e descontos especiais!\n\n🔒 É apenas um convite, sem spam. Você entra somente se quiser!\n\n👇 Entre aqui:\n{link}\n\n🙏 Obrigado pela atenção!';
const INTERVALS = [[5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [720, '12 h'], [1440, '24 h']] as const;
const STATUS: Record<string, [string, string]> = {
  ANSWERED: ['Atendido', 'badge-on'], COUPONS: ['Cupons enviados', 'badge-on'], COUPONS_REPEAT: ['Pediu cupom de novo', 'badge-off'], ASK: ['Perguntou a loja (cupom)', 'badge-ready'], ASK_STORE: ['Perguntou a loja', 'badge-ready'], DETAIL: ['Pediu detalhes', 'badge-ready'], ASK_NAME: ['Perguntou o nome', 'badge-ready'], NAME: ['Disse o nome', 'badge-on'], MEDIA: ['Mandou áudio/foto', 'badge-off'], MANUAL: ['Enviado pelo painel', 'badge-on'], EMPTY: ['Nada encontrado', 'badge-ready'], LIMITED: ['Aguardando limite (envia sozinho)', 'badge-ready'], LIMITED_SENT: ['Enviado após o limite', 'badge-on'],
  INVITE: ['Convite para o grupo', 'badge-on'], HELP: ['Boas-vindas', 'badge-off'], OPT_OUT: ['Pediu para parar', 'badge-off'], OPT_IN: ['Voltou', 'badge-on'], BLOCKED: ['Bloqueado', 'badge-off'], FAILED: ['Falhou', 'badge-off']
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const phoneFmt = (c: Customer) => {
  const p = c.phone || '';
  if (/^55\d{10,11}$/.test(p)) return `+55 (${p.slice(2, 4)}) ${p.slice(4, -4)}-${p.slice(-4)}`;
  return p ? `+${p}` : 'número oculto';
};

export default function Customers() {
  const [data, setData] = useState<Payload>();
  const [bot, setBot] = useState<Bot>();
  const [busy, setBusy] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [test, setTest] = useState('');
  const [intent, setIntent] = useState<any>();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // Convite para o grupo de ofertas.
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');
  // A mensagem fica salva no banco (CustomerBot.inviteText); null = ainda não carregou.
  const [inviteText, setInviteText] = useState<string | null>(null);
  const savedInvite = useRef<string | null>(null);
  const [inviteSave, setInviteSave] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [phonesText, setPhonesText] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [inviteState, setInviteState] = useState<InviteState>({ counts: {}, jobs: {} });
  const [file, setFile] = useState<{ name: string; phones: string[]; skipped: number } | null>(null);
  const [pauseSec, setPauseSec] = useState(60);
  const [dailyLimit, setDailyLimit] = useState(50);
  // Número que manda os convites (pedido do usuário em 2026-10-09): fica lembrado neste navegador.
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  const [via, setViaState] = useState(() => { try { return localStorage.getItem(VIA_KEY) || ''; } catch { return ''; } });
  const setVia = (id: string) => { setViaState(id); try { localStorage.setItem(VIA_KEY, id); } catch { /* ignora */ } };
  const senders = numbers.filter(n => !n.disposable && n.status === 'connected' && n.me?.id);
  // Número lembrado que caiu: usa o principal (ou o primeiro conectado) até ele voltar.
  const viaId = senders.some(n => n.id === via) ? via : (senders.find(n => n.main) || senders[0])?.id || '';
  const viaPhone = senders.find(n => n.id === viaId)?.me?.id;
  // Fila e contagem do número escolhido; as dos outros números aparecem só como aviso.
  const invite = inviteState.jobs[viaId] || null;
  const sentToday = inviteState.counts[viaId] || 0;
  const otherJobs = Object.entries(inviteState.jobs).filter(([id, j]) => id !== viaId && j.running);
  const anyRunning = Object.values(inviteState.jobs).some(j => j.running);
  // Telefones do arquivo + os digitados, sem repetir.
  const typed = parsePhones(phonesText).phones;
  const allPhones = [...new Set([...(file?.phones || []), ...typed])];

  async function loadFile(f: File | null) {
    if (!f) return setFile(null);
    const { phones, skipped } = parsePhones(await f.text());
    setFile({ name: f.name, phones, skipped });
    notify(phones.length ? `${phones.length} contato(s) carregados de "${f.name}". Confira e clique em Enviar.` : 'Não achei nenhum telefone no arquivo. Coloque um número por linha, com DDD.', phones.length ? 'info' : 'error');
  }
  async function stopInvite() {
    if (!confirm('Parar os convites? Quem já recebeu, recebeu; o resto não sai mais.')) return;
    try { const r = await api.post('/api/customers/invite/stop', { session: viaId }); setInviteState(r.data); } catch { notify('Não foi possível parar.', 'error'); }
  }

  const loadGroups = () => api.get('/api/whatsapp/groups').then(r => { setGroups(r.data); setGroupId(g => g || r.data[0]?.id || ''); }).catch(() => setGroups([]));
  const loadInvite = () => api.get('/api/customers/invite').then(r => setInviteState(r.data)).catch(() => {});
  const loadNumbers = () => api.get('/api/whatsapp/status').then(r => setNumbers(r.data.sessions || [])).catch(() => {});
  useEffect(() => { loadGroups(); loadInvite(); loadNumbers(); const t = setInterval(loadNumbers, 30_000); return () => clearInterval(t); }, []);
  // Enquanto os convites saem, acompanha a cada 5 s.
  useEffect(() => { if (!anyRunning) return; const t = setInterval(loadInvite, 5000); return () => clearInterval(t); }, [anyRunning]);

  async function sendInvite(customerIds: string[], phones: string[]) {
    const g = groups.find(x => x.id === groupId);
    if (!g) return notify('Escolha o grupo de ofertas.', 'error');
    if (!inviteText?.includes('{link}')) return notify('A mensagem precisa ter {link} no lugar do link do grupo.', 'error');
    const n = customerIds.length + phones.length;
    if (!n) return notify('Marque ao menos um cliente ou digite um telefone.', 'error');
    const limit = Math.min(1000, Math.max(1, Math.round(dailyLimit) || 50));
    if (!viaId) return notify('Nenhum número conectado para mandar o convite. Conecte um em Canais.', 'error');
    if (n > 1 && !confirm(`Mandar o convite de "${g.name}" para ${n} pessoa(s) pelo número +${viaPhone}?\n\nVai uma mensagem de cada vez, com ${fmtPause(pauseSec)} entre elas (variando um pouco) e no máximo ${limit} por dia — leva ${fmtPlan(n, pauseSec, limit, sentToday)}. O sistema precisa ficar ligado.`)) return;
    setBusy('invite');
    try {
      const r = await api.post('/api/customers/invite', { groupId: g.id, groupName: g.name, text: inviteText, customerIds, phones, pauseSec, dailyLimit: limit, session: viaId });
      setInviteState(r.data); setSelected({}); setPhonesText(''); setFile(null);
      const total = r.data.job?.total ?? n, already = r.data.job?.already || 0;
      if (!total && already) notify(already === 1 ? 'Essa pessoa já recebeu o convite deste grupo, então não mandei de novo.' : `Todas as ${already} pessoas já tinham recebido o convite deste grupo, então não mandei de novo.`);
      else notify(`${total === 1 ? 'Convite a caminho.' : `Convites a caminho: ${total} pessoa(s).`}${already ? ` ${already} já tinham recebido e foram puladas.` : ''}`);
    } catch (e: any) { notify(e?.response?.data?.error || e?.response?.data?.issues?.[0]?.message || 'Não foi possível mandar o convite.', 'error'); }
    finally { setBusy(''); }
  }

  // Falhou o carregamento: mostra o motivo e tenta de novo em 5 s (antes ficava "Carregando..." até 30 s, calado).
  const [loadError, setLoadError] = useState('');
  const load = () => api.get('/api/customers').then(r => { setData(r.data); setBot(r.data.bot); setLoadError(''); }).catch((e: any) => setLoadError(e?.response?.data?.error || 'Não consegui falar com o sistema.'));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!loadError || data) return; const t = setTimeout(load, 5_000); return () => clearTimeout(t); }, [loadError, data]);

  // Mensagem do convite: carrega a salva uma vez e salva sozinha 1 s depois de parar de digitar.
  useEffect(() => { if (data && inviteText === null) { const t = data.bot.inviteText || DEFAULT_INVITE; savedInvite.current = t; setInviteText(t); } }, [data]);
  useEffect(() => {
    if (inviteText === null || inviteText === savedInvite.current) return;
    setInviteSave('saving');
    const t = setTimeout(async () => {
      try {
        await api.put('/api/customers/bot', { inviteText: inviteText.trim() === DEFAULT_INVITE ? null : inviteText });
        savedInvite.current = inviteText; setInviteSave('saved');
      } catch { setInviteSave('error'); }
    }, 1000);
    return () => clearTimeout(t);
  }, [inviteText]);

  async function saveBot(patch: Partial<Bot>) {
    setBusy('bot');
    try { const r = await api.put('/api/customers/bot', patch); setData(r.data); setBot(r.data.bot); notify('Atendimento salvo.'); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível salvar.', 'error'); }
    finally { setBusy(''); }
  }
  async function showQr() {
    try { const r = await api.get('/api/customers/link-qr'); setQr(r.data.qr); }
    catch (e: any) { notify(e?.response?.data?.error || 'WhatsApp não conectado.', 'error'); }
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); notify('Link copiado.'); } catch { notify('Não foi possível copiar.', 'error'); } }
  async function testPhrase() {
    if (!test.trim()) return;
    try { const r = await api.post('/api/customers/parse', { text: test }); setIntent(r.data); } catch { /* ignora */ }
  }
  async function patchCustomer(c: Customer, patch: Partial<Customer>) {
    try { await api.patch(`/api/customers/${c.id}`, patch); load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível alterar.', 'error'); }
  }
  async function remove(c: Customer) {
    if (!confirm(`Apagar ${c.givenName || c.name || phoneFmt(c)} e o histórico dele?`)) return;
    try { await api.delete(`/api/customers/${c.id}`); load(); } catch { notify('Não foi possível apagar.', 'error'); }
  }

  const mktLabel = (m: string) => m === 'ALL' ? 'todas as lojas' : mktName(m);
  // Mesma ordem da API: é a numeração que o robô mostra ao cliente (1 Shopee, 2 Mercado Livre, 3 Amazon...).
  const stores = bot ? MKTS.filter(m => bot.marketplaces.includes(m)) : [];
  const anyNumber = stores.length + 1;
  const asksStore = bot && bot.askMarketplace && bot.marketplaces.length > 1;
  const intentText = (i: any) => !i ? '' : i.kind === 'SEARCH' ? (i.details ? `Pedido genérico: o robô pergunta ${i.details.items.map((x: string) => x.replace(/\s*\(.*$/, '')).join(', ')} de "${i.keyword}"${asksStore ? ', depois a loja,' : ''} e busca com a resposta` : `Busca por "${i.keyword}"${i.marketplace ? ` só na ${mktLabel(i.marketplace)}` : asksStore ? ' (robô pergunta a loja antes)' : ''}${i.wantsCoupons ? ' + cupons' : ''}`) : i.kind === 'COUPONS' ? (i.marketplace ? `Cupons: ${mktLabel(i.marketplace)}` : 'Cupons (robô pergunta a loja)') : i.kind === 'MARKETPLACE' ? `Resposta "qual loja": ${mktLabel(i.marketplace)}` : i.kind === 'OPT_OUT' ? 'Cliente pede para parar (não recebe mais nada)' : i.kind === 'OPT_IN' ? 'Cliente volta a receber' : 'Boas-vindas / ajuda';
  const list = (data?.customers || []).filter(c => { const f = filter.trim().toLowerCase(); return !f || (c.name || '').toLowerCase().includes(f) || (c.givenName || '').toLowerCase().includes(f) || (c.phone || '').includes(f.replace(/\D/g, '')) || (c.lastRequest?.keyword || '').toLowerCase().includes(f); });

  if (!data || !bot) return <section className="page"><h1>Clientes</h1><div className="loading">{loadError ? `${loadError} Tentando de novo...` : 'Carregando...'}</div></section>;

  return <section className="page">
    <div className="page-title-row"><div><h1>Clientes</h1><p>Quem fala com você no privado do WhatsApp recebe ofertas só pra ele. Divulgue o link, o cliente escreve o que procura e o robô responde.</p></div>
      <span className={`badge ${bot.enabled && data.waConnected ? 'badge-on' : 'badge-off'}`}>{bot.enabled ? (data.waConnected ? '● Atendendo' : '● Ligado, WhatsApp desconectado') : '○ Desligado'}</span></div>

    <div className="list-grid">
      <div className="card">
        <h2><Bot size={20} /> Atendimento automático</h2>
        <label className="check-line" style={{ marginTop: 6 }}><input type="checkbox" checked={bot.enabled} onChange={e => saveBot({ enabled: e.target.checked })} /> Responder clientes automaticamente</label>
        <div className="env-field" style={{ marginTop: 16 }}><label><Clock3 size={15} /> Limite por tempo (por cliente)</label>
          <select value={bot.everyMinutes} onChange={e => saveBot({ everyMinutes: Number(e.target.value) })}>{INTERVALS.map(([v, l]) => <option key={v} value={v}>1 pedido a cada {l}</option>)}{!INTERVALS.some(([v]) => v === bot.everyMinutes) && <option value={bot.everyMinutes}>1 pedido a cada {bot.everyMinutes} min</option>}</select>
          <small>Dentro desse tempo o cliente recebe o aviso "em X min eu te mando" e, passado o tempo, as ofertas saem sozinhas, sem ele pedir de novo. Evita enxurrada e denúncia de spam.</small></div>
        <div className="env-field"><label>Ofertas por pedido <em>mais vendidos</em></label>
          <select value={bot.maxOffers} onChange={e => saveBot({ maxOffers: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} {n === 1 ? 'oferta' : 'ofertas'}</option>)}</select></div>
        <div className="env-field"><label>Onde buscar</label>
          <div className="chip-list" style={{ margin: 0 }}>{MKTS.map(m => { const on = bot.marketplaces.includes(m); return <button key={m} type="button" className={`chip-toggle ${on ? 'on' : ''}`} onClick={() => { const next = on ? bot.marketplaces.filter(x => x !== m) : MKTS.filter(x => x === m || bot.marketplaces.includes(x)); if (!next.length) return notify('Marque ao menos um marketplace.', 'info'); saveBot({ marketplaces: next }); }}>{mktIcon(m)} {mktName(m)}</button>; })}</div>
          {bot.marketplaces.includes('AMAZON') && <small>Amazon: a busca usa a Creators API (Configurações → Amazon), liberada pela Amazon só depois de vendas recentes pelo seu link. Sem ela, os pedidos na Amazon voltam "não consegui buscar".</small>}</div>
        <div className="env-field"><label><Store size={15} /> Perguntar a loja ao cliente</label>
          <label className="check-line" style={{ marginTop: 2 }}><input type="checkbox" checked={bot.askMarketplace} disabled={bot.marketplaces.length < 2} onChange={e => saveBot({ askMarketplace: e.target.checked })} /> Antes de buscar, o robô pergunta em qual loja</label>
          <div className="chip-list" style={{ margin: '8px 0 0' }}>{stores.map((m, i) => <span className="chip" key={m}>{i + 1} · {mktIcon(m)} {mktName(m)}</span>)}<span className="chip">{anyNumber} · 🔀 Qualquer uma</span></div>
          <small>{bot.marketplaces.length < 2 ? 'Só funciona com duas ou mais lojas marcadas em "Onde buscar".' : `O cliente responde com o número (${stores.map((_, i) => i + 1).join(', ')} ou ${anyNumber}) ou o nome da loja. Se ele já disser a loja no pedido ("fone na shopee"), o robô não pergunta. Desligado: busca em todas as lojas marcadas e intercala.`}</small></div>
        <label className="check-line"><input type="checkbox" checked={bot.sendCoupons} onChange={e => saveBot({ sendCoupons: e.target.checked })} /> Se o cliente pedir cupom, manda o listão de cupons válidos junto</label>
        <div className="env-field" style={{ marginTop: 16 }}><label>Mensagem de boas-vindas <em>opcional</em></label>
          <textarea rows={5} value={bot.welcomeText || ''} placeholder={'Vazio = mensagem padrão (explica como pedir, como pedir cupom e como sair).'} title="No primeiro contato o robô só se apresenta e pergunta o nome do cliente; este texto vai logo depois que ele responde o nome." onChange={e => setBot({ ...bot, welcomeText: e.target.value })} onBlur={() => { if ((bot.welcomeText || '') !== (data.bot.welcomeText || '')) saveBot({ welcomeText: bot.welcomeText || null }); }} /></div>
        <p className="hint">Comandos que o cliente pode usar: <b>chega de oferta</b> (para de receber), <b>quero oferta</b> (volta a receber), <b>cupom</b> (o robô pergunta de qual loja, com as opções numeradas, e manda os cupons ativos da loja com seu link da tela Cupons, na hora, sem esperar o limite; <b>cupom shopee</b> pula a pergunta). Pedido = qualquer texto, ex.: "fone bluetooth". Pedido de uma palavra só ("tv", "celular", "furadeira"...) faz o robô perguntar tamanho, marca e modelo antes de buscar (os produtos mais comuns têm perguntas próprias); a resposta do cliente vira a busca ("tv 50 samsung 4k"). Com a opção acima ligada, o robô também pergunta em qual loja buscar (as lojas marcadas ou qualquer uma) quando o cliente não disse; a resposta vale 30 min e não gasta o limite por tempo. Toda mensagem recebe resposta, até áudio e foto ("escreva o produto"). Na primeira conversa o robô pergunta o nome do cliente e passa a chamá-lo pelo nome.</p>
      </div>

      <div className="card">
        <h2><MessageCircle size={20} /> Seu link para clientes</h2>
        {!data.waConnected && <div className="ml-steps">WhatsApp não conectado. Escaneie o QR code em <b>Canais</b> para o link aparecer e o robô responder.</div>}
        {data.link && <>
          <div className="env-field"><label>Link (cole na bio, nos grupos, no status)</label>
            <div style={{ display: 'flex', gap: 8 }}><input readOnly value={data.link} onFocus={e => e.currentTarget.select()} style={{ flex: 1 }} /><button className="outline" onClick={() => copy(data.link!)} title="Copiar"><Copy size={16} /></button></div>
            <small>Abre o WhatsApp do número {data.waNumber ? `+${data.waNumber}` : 'pareado'} com a frase já digitada. O cliente só aperta enviar.</small></div>
          <div className="env-field"><label>Frase que já vem digitada</label>
            <input value={bot.linkText ?? ''} placeholder="Quero oferta" onChange={e => setBot({ ...bot, linkText: e.target.value })} onBlur={() => { if ((bot.linkText || '') !== (data.bot.linkText || '')) saveBot({ linkText: bot.linkText || null }); }} />
            <small>Dica: uma frase que já é um pedido ("Quero oferta de ...") faz o cliente completar com o produto.</small></div>
          <div className="capture-actions"><button className="outline" onClick={showQr}><QrCode size={16} /> Mostrar QR code</button>{qr && <a className="outline button" href={qr} download="link-ofertas.png">Baixar QR</a>}</div>
          {qr && <img src={qr} alt="QR code do link" style={{ width: 220, marginTop: 14, borderRadius: 12, background: '#fff', padding: 8 }} />}
        </>}
        <div className="env-field" style={{ marginTop: 18 }}><label>Testar como o robô entende uma frase</label>
          <div style={{ display: 'flex', gap: 8 }}><input value={test} placeholder='ex.: "quero uma oferta de air fryer com cupom"' onChange={e => setTest(e.target.value)} onKeyDown={e => e.key === 'Enter' && testPhrase()} style={{ flex: 1 }} /><button className="outline" onClick={testPhrase}>Testar</button></div>
          {intent && <small><b>{intentText(intent)}</b></small>}</div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 18 }}>
      <h2><Users size={20} /> Convidar para o grupo de ofertas</h2>
      <p className="muted">Manda o link de convite de um grupo no privado do cliente. Marque os clientes na lista abaixo e use "Convidar marcados", ou carregue uma planilha/digite telefones aqui. Os convites saem um por um, com pausa e limite por dia, para o WhatsApp não bloquear o número.</p>
      {!data.waConnected && <div className="ml-steps">WhatsApp não conectado. Escaneie o QR code em <b>Canais</b>.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
        <div>
          <div className="env-field"><label>Grupo de ofertas</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={groupId} onChange={e => setGroupId(e.target.value)} style={{ flex: 1 }}>
                {!groups.length && <option value="">{data.waConnected ? 'Carregando grupos...' : 'Conecte o WhatsApp em Canais'}</option>}
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.participants})</option>)}
              </select>
              <button className="outline" onClick={loadGroups} title="Atualizar grupos"><RefreshCw size={16} /></button>
            </div>
            <small>Você precisa ser administrador do grupo para o sistema pegar o link de convite.</small></div>
          <div className="env-field"><label>Enviar pelo número</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={viaId} onChange={e => setVia(e.target.value)} style={{ flex: 1 }} disabled={!senders.length}>
                {!senders.length && <option value="">Nenhum número conectado</option>}
                {senders.map(n => <option key={n.id} value={n.id}>+{n.me!.id}{n.me!.name ? ` · ${n.me!.name}` : ''}{n.main ? ' (principal)' : ''}</option>)}
              </select>
              <button className="outline" onClick={loadNumbers} title="Atualizar números"><RefreshCw size={16} /></button>
            </div>
            <small>{viaPhone ? <>Os convites saem do <b>+{viaPhone}</b>. O link do grupo vem de um número que é administrador dele. Se esse número cair no meio, a fila espera ele voltar — não troca sozinha.</> : 'Conecte um número em Canais.'}</small></div>
          <div className="env-field"><label>Mensagem do convite (use {'{nome}'}, {'{grupo}'} e {'{link}'})</label>
            <textarea rows={11} value={inviteText ?? ''} onChange={e => setInviteText(e.target.value)} />
            <small>{inviteSave === 'saving' ? 'Salvando...' : inviteSave === 'saved' ? '✓ Salvo automaticamente' : inviteSave === 'error' ? 'Não foi possível salvar, tente de novo.' : 'Salva sozinha enquanto você digita.'}
              {inviteText !== DEFAULT_INVITE && <> · <a href="#" onClick={e => { e.preventDefault(); setInviteText(DEFAULT_INVITE); }}>Voltar ao modelo padrão</a></>}</small></div>
        </div>
        <div>
          <div className="env-field"><label><FileUp size={15} /> Importar contatos de um arquivo CSV/TXT <em>opcional</em></label>
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={e => loadFile(e.target.files?.[0] || null)} />
            <small>Pode ser a planilha baixada em Canais → "Extrair contatos" ou um arquivo com um telefone por linha, com DDD. Os contatos são carregados primeiro; só saem quando você clicar em Enviar.</small>
            {file && <div className="inline-msg" style={{ marginTop: 6 }}>
              <b>{file.phones.length} contato(s) carregados de "{file.name}"</b>{file.skipped ? ` · ${file.skipped} linha(s) sem telefone válido ignoradas` : ''}
              {file.phones.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{file.phones.slice(0, 8).map(p => `+${p}`).join(', ')}{file.phones.length > 8 ? ` e mais ${file.phones.length - 8}` : ''}</div>}
              <button className="outline" style={{ marginTop: 6 }} onClick={() => setFile(null)}>Limpar</button>
            </div>}</div>
          <div className="env-field"><label>Ou digite telefones <em>opcional</em></label>
            <textarea rows={3} value={phonesText} onChange={e => setPhonesText(e.target.value)} placeholder={'Um por linha ou separados por vírgula, com DDD. Ex.:\n44 99999-9999\n5511988887777'} />
            <small>Para quem ainda não falou com o robô. Sem o 55 na frente, entende como número do Brasil.</small></div>
          <div className="form-row form-row-tight">
            <label>Esperar entre cada convite
              <select value={pauseSec} onChange={e => setPauseSec(Number(e.target.value))}>{PAUSES.map(p => <option key={p} value={p}>{fmtPause(p)}</option>)}</select>
            </label>
            <label>Limite por dia
              <input type="number" min={1} max={1000} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))} />
            </label>
          </div>
          <small className="muted">Hoje já saíram {sentToday} convite(s){viaPhone ? ` pelo +${viaPhone}` : ''} — cada número tem a sua fila e o seu limite por dia. A pausa varia um pouco (70% a 150% do escolhido) para não ter ritmo de máquina. Quando o limite do dia acaba, a fila espera a meia-noite e continua sozinha — o sistema precisa ficar ligado. Se reiniciar, continua de onde parou.</small>
          <button className="primary" disabled={!data.waConnected || busy === 'invite' || !allPhones.length || !!invite?.running} onClick={() => sendInvite([], allPhones)} style={{ alignSelf: 'flex-start', marginTop: 10 }}><UserPlus size={15} /> Enviar convite para {allPhones.length || 'os'} telefone(s){viaPhone ? ` pelo +${viaPhone}` : ''}</button>
          {invite && <div className="inline-msg" style={{ marginTop: 12 }}>
            <b>Convites para "{invite.groupName}"{invite.sessionPhone ? ` pelo número +${invite.sessionPhone}` : ''}:</b> {invite.sent} de {invite.total} enviado(s){invite.failed.length ? ` · ${invite.failed.length} com erro` : ''}{invite.already ? ` · ${invite.already} já tinham recebido este convite (pulados)` : ''}{invite.skipped ? ` · ${invite.skipped} pulado(s) (pediram para parar ou bloqueados)` : ''}{invite.running ? '…' : '.'}
            {invite.running && !!invite.left && invite.pauseSec && <div>Faltam {invite.left}: {fmtPlan(invite.left, invite.pauseSec, invite.dailyLimit || 1000, sentToday)}.</div>}
            {invite.running && invite.waitingUntil && <div>⏸️ Limite de {invite.dailyLimit} por dia atingido. Continua sozinha {new Date(invite.waitingUntil).toLocaleString('pt-BR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.</div>}
            {invite.running && (invite.stopped ? <div>Parando…</div> : <button className="outline" style={{ marginTop: 8 }} onClick={stopInvite}><Square size={15} /> Parar convites</button>)}
            {!invite.running && invite.stopped && <div>Parado por você{invite.left ? ` — ${invite.left} não receberam` : ''}.</div>}
            {invite.failed.length > 0 && <div>Não deu para: {invite.failed.slice(0, 10).join(', ')}{invite.failed.length > 10 ? ` e mais ${invite.failed.length - 10}` : ''}</div>}
            {invite.error && <div>Ops, o envio parou: {invite.error}</div>}
          </div>}
          {otherJobs.map(([id, j]) => <div key={id} className="inline-msg" style={{ marginTop: 8 }}>
            Também saindo pelo <b>+{j.sessionPhone || id}</b>: "{j.groupName}", {j.sent} de {j.total}. <a href="#" onClick={e => { e.preventDefault(); setVia(id); }}>Ver esta fila</a>
          </div>)}
        </div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head"><h2><History size={20} /> Clientes ({data.customers.length})</h2>
        <div style={{ display: 'flex', gap: 8 }}><input value={filter} placeholder="Buscar por nome, número ou produto" onChange={e => setFilter(e.target.value)} /><button className="outline" onClick={load} title="Atualizar"><RefreshCw size={16} /></button></div></div>
      {!list.length && <p className="empty">Ninguém escreveu ainda. Divulgue o link acima: quem mandar mensagem aparece aqui.</p>}
      {list.length > 0 && <div className="capture-actions" style={{ marginBottom: 12 }}>
        <button className="primary" disabled={!data.waConnected || busy === 'invite' || !!invite?.running || !list.some(c => selected[c.id])} onClick={() => sendInvite(list.filter(c => selected[c.id]).map(c => c.id), [])}><UserPlus size={16} /> Convidar marcados para o grupo ({list.filter(c => selected[c.id]).length})</button>
        <button className="outline" onClick={() => setSelected(Object.fromEntries(list.filter(c => !c.blocked && !c.optedOut).map(c => [c.id, true])))}>Marcar todos</button>
        <button className="outline" onClick={() => setSelected({})}>Desmarcar</button>
      </div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map(c => <CustomerRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onPatch={p => patchCustomer(c, p)} onRemove={() => remove(c)} onSent={load} waConnected={data.waConnected}
          selected={!!selected[c.id]} onSelect={on => setSelected(v => ({ ...v, [c.id]: on }))} onInvite={() => sendInvite([c.id], [])} inviteBusy={busy === 'invite' || !!invite?.running || !groupId} />)}
      </div>
    </div>
  </section>;
}

function CustomerRow({ c, open, onToggle, onPatch, onRemove, onSent, waConnected, selected, onSelect, onInvite, inviteBusy }: { c: Customer; open: boolean; onToggle: () => void; onPatch: (p: Partial<Customer>) => void; onRemove: () => void; onSent: () => void; waConnected: boolean; selected: boolean; onSelect: (on: boolean) => void; onInvite: () => void; inviteBusy: boolean }) {
  const [reqs, setReqs] = useState<any[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [coupons, setCoupons] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { if (open) api.get(`/api/customers/${c.id}/requests`).then(r => setReqs(r.data)).catch(() => setReqs([])); }, [open, c.requestCount, c.lastSeenAt]);

  async function send(body: any) {
    setBusy('send');
    try { const r = await api.post(`/api/customers/${c.id}/send`, body); notify(body.keyword ? `${r.data.count} oferta(s) enviada(s) para ${c.givenName || c.name || phoneFmt(c)}.` : 'Mensagem enviada.'); setKeyword(''); setText(''); onSent(); setReqs(null); api.get(`/api/customers/${c.id}/requests`).then(r => setReqs(r.data)).catch(() => {}); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível enviar.', 'error'); }
    finally { setBusy(''); }
  }
  const st = c.lastRequest ? STATUS[c.lastRequest.status] || [c.lastRequest.status, 'badge-off'] : null;

  return <div className="user-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <input type="checkbox" checked={selected} disabled={c.blocked || c.optedOut} title="Marcar para convidar para o grupo" onChange={e => onSelect(e.target.checked)} />
      <div className="user-main"><b>{c.givenName || c.name || phoneFmt(c)} {(c.givenName || c.name) && <small>· {c.givenName && c.name && c.name !== c.givenName ? `${c.name} · ` : ''}{phoneFmt(c)}</small>}</b>
        <small>{c.requestCount} pedido(s) · última mensagem {when(c.lastSeenAt)}{c.lastRequest?.keyword ? ` · pediu "${c.lastRequest.keyword}"` : ''}</small></div>
      {c.blocked && <span className="badge badge-off"><Ban size={13} /> Bloqueado</span>}
      {!c.blocked && c.optedOut && <span className="badge badge-off">Pediu para parar</span>}
      {!c.blocked && !c.optedOut && st && <span className={`badge ${st[1]}`}>{st[0]}</span>}
      <button className="outline" onClick={onToggle}><Send size={15} /> {open ? 'Fechar' : 'Enviar / histórico'}</button>
      <button className="icon-btn" title={c.blocked ? 'Desbloquear' : 'Bloquear (ignora as mensagens dele)'} onClick={() => onPatch({ blocked: !c.blocked })}><Power size={17} /></button>
      <button className="icon-btn" title="Apagar cliente" onClick={onRemove}><Trash2 size={17} /></button>
    </div>
    {open && <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
      <div>
        <div className="env-field"><label>Enviar oferta só para este cliente</label>
          <div style={{ display: 'flex', gap: 8 }}><input value={keyword} placeholder="produto, ex.: fone bluetooth" onChange={e => setKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && keyword.trim().length >= 2 && send({ keyword, coupons })} style={{ flex: 1 }} /><button className="primary" disabled={!waConnected || busy === 'send' || keyword.trim().length < 2 || c.optedOut} onClick={() => send({ keyword, coupons })}>{busy === 'send' ? 'Enviando...' : 'Buscar e enviar'}</button></div>
          <label className="check-line" style={{ marginTop: 8 }}><input type="checkbox" checked={coupons} onChange={e => setCoupons(e.target.checked)} /> Mandar cupons junto</label>
          {c.optedOut && <small>Este cliente pediu para parar. Só volta a receber se escrever "quero oferta".</small>}</div>
        <div className="env-field"><label>Ou uma mensagem livre</label>
          <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Ex.: Oi! Vi que você procurou fone; chegou um com 40% off hoje..." />
          <button className="outline" disabled={!waConnected || busy === 'send' || !text.trim() || c.optedOut} onClick={() => send({ text })} style={{ alignSelf: 'flex-start' }}><Send size={15} /> Enviar texto</button></div>
        <div className="env-field"><label>Convite para o grupo de ofertas</label>
          <button className="outline" disabled={!waConnected || inviteBusy || c.optedOut || c.blocked} onClick={onInvite} style={{ alignSelf: 'flex-start' }}><UserPlus size={15} /> Mandar o link do grupo escolhido acima</button>
          <small>Usa o grupo e a mensagem do quadro "Convidar para o grupo de ofertas".</small></div>
      </div>
      <div>
        <b style={{ display: 'block', marginBottom: 8 }}>Histórico</b>
        {reqs === null && <small className="muted">Carregando...</small>}
        {reqs && !reqs.length && <small className="muted">Sem mensagens registradas.</small>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto' }}>
          {reqs?.map(r => { const s = STATUS[r.status] || [r.status, 'badge-off']; const offers = Array.isArray(r.offersJson) ? r.offersJson : []; return <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><small className="muted">{when(r.createdAt)}</small><span className={`badge ${s[1]}`}>{s[0]}</span>{r.keyword && <small>busca: <b>{r.keyword}</b></small>}</div>
            <div style={{ marginTop: 6, fontSize: 14 }}>💬 {r.text}</div>
            {offers.length > 0 && <div style={{ marginTop: 6, fontSize: 13 }} className="muted">{offers.map((o: any, i: number) => <div key={i}>• <a className="offer-link" href={o.affiliateUrl} target="_blank" rel="noreferrer">{o.title}</a>{o.price != null ? ` — R$ ${Number(o.price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}</div>)}</div>}
            {r.error && <small className="log-err">{r.error}</small>}
          </div>; })}
        </div>
      </div>
    </div>}
  </div>;
}
