import { useEffect, useState } from 'react';
import { Copy, MessageCircle, Power, QrCode, RefreshCw, Send, Trash2, Ban, History, Bot, Clock3, Store, UserPlus, Users } from 'lucide-react';
import { api } from './api';
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

type Bot = { enabled: boolean; everyMinutes: number; maxOffers: number; marketplaces: Mkt[]; askMarketplace: boolean; sendCoupons: boolean; welcomeText?: string | null; linkText?: string | null };
type Customer = { id: string; jid: string; phone?: string | null; name?: string | null; givenName?: string | null; notes?: string | null; blocked: boolean; optedOut: boolean; requestCount: number; lastRequestAt?: string | null; firstSeenAt: string; lastSeenAt: string; lastRequest?: { keyword?: string | null; status: string; createdAt: string; text: string } | null };
type Payload = { bot: Bot; link: string | null; waConnected: boolean; waNumber: string | null; customers: Customer[] };
type Group = { id: string; name: string; participants: number };
type Invite = { groupName: string; total: number; sent: number; failed: string[]; skipped: number; running: boolean; error: string | null };

// {nome} vira ", Fulano" (ou some, se o nome não for conhecido); {grupo} e {link} são trocados pelo servidor.
const DEFAULT_INVITE = 'Oi{nome}! 😊 Tenho um grupo no WhatsApp onde mando as melhores ofertas do dia: *{grupo}*. Se quiser entrar, é só tocar no link:\n{link}\n\nQualquer dúvida, estou por aqui!';
/** Telefones digitados (um por linha ou separados por vírgula). 10–11 dígitos sem o 55 = Brasil. */
function parsePhones(text: string) {
  const out = new Set<string>();
  for (const part of text.split(/[\n,;]+/)) {
    const d = part.replace(/\D/g, '');
    if (/^\d{10,11}$/.test(d) && !d.startsWith('55')) out.add(`55${d}`);
    else if (/^\d{12,15}$/.test(d)) out.add(d);
  }
  return [...out];
}

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
  const [inviteText, setInviteText] = useState(DEFAULT_INVITE);
  const [phonesText, setPhonesText] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [invite, setInvite] = useState<Invite | null>(null);

  const loadGroups = () => api.get('/api/whatsapp/groups').then(r => { setGroups(r.data); setGroupId(g => g || r.data[0]?.id || ''); }).catch(() => setGroups([]));
  const loadInvite = () => api.get('/api/customers/invite').then(r => setInvite(r.data)).catch(() => {});
  useEffect(() => { loadGroups(); loadInvite(); }, []);
  // Enquanto os convites saem, acompanha a cada 5 s.
  useEffect(() => { if (!invite?.running) return; const t = setInterval(loadInvite, 5000); return () => clearInterval(t); }, [invite?.running]);

  async function sendInvite(customerIds: string[], phones: string[]) {
    const g = groups.find(x => x.id === groupId);
    if (!g) return notify('Escolha o grupo de ofertas.', 'error');
    if (!inviteText.includes('{link}')) return notify('A mensagem precisa ter {link} no lugar do link do grupo.', 'error');
    const n = customerIds.length + phones.length;
    if (!n) return notify('Marque ao menos um cliente ou digite um telefone.', 'error');
    if (n > 1 && !confirm(`Mandar o convite de "${g.name}" para ${n} pessoa(s)?\n\nVai uma mensagem de cada vez, com uns 30 segundos entre elas, para proteger o número.`)) return;
    setBusy('invite');
    try {
      const r = await api.post('/api/customers/invite', { groupId: g.id, groupName: g.name, text: inviteText, customerIds, phones });
      setInvite(r.data); setSelected({}); setPhonesText('');
      notify(n === 1 ? 'Convite enviado.' : `Convites a caminho: ${r.data.total} pessoa(s).`);
    } catch (e: any) { notify(e?.response?.data?.error || e?.response?.data?.issues?.[0]?.message || 'Não foi possível mandar o convite.', 'error'); }
    finally { setBusy(''); }
  }

  const load = () => api.get('/api/customers').then(r => { setData(r.data); setBot(r.data.bot); }).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

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

  if (!data || !bot) return <section className="page"><h1>Clientes</h1><div className="loading">Carregando...</div></section>;

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
      <p className="muted">Manda o link de convite de um grupo no privado do cliente. Marque os clientes na lista abaixo e use "Convidar marcados", ou digite telefones aqui.</p>
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
          <div className="env-field"><label>Mensagem do convite (use {'{nome}'}, {'{grupo}'} e {'{link}'})</label>
            <textarea rows={5} value={inviteText} onChange={e => setInviteText(e.target.value)} /></div>
        </div>
        <div>
          <div className="env-field"><label>Telefones para convidar <em>opcional</em></label>
            <textarea rows={4} value={phonesText} onChange={e => setPhonesText(e.target.value)} placeholder={'Um por linha ou separados por vírgula, com DDD. Ex.:\n44 99999-9999\n5511988887777'} />
            <small>Para quem ainda não falou com o robô. Sem o 55 na frente, entende como número do Brasil.</small>
            <button className="primary" disabled={!data.waConnected || busy === 'invite' || !parsePhones(phonesText).length || !!invite?.running} onClick={() => sendInvite([], parsePhones(phonesText))} style={{ alignSelf: 'flex-start', marginTop: 6 }}><UserPlus size={15} /> Enviar convite para {parsePhones(phonesText).length || 'os'} telefone(s)</button></div>
          {invite && <div className="inline-msg">
            <b>Convites para "{invite.groupName}":</b> {invite.sent} de {invite.total} enviado(s){invite.failed.length ? ` · ${invite.failed.length} com erro` : ''}{invite.skipped ? ` · ${invite.skipped} pulado(s) (pediram para parar ou bloqueados)` : ''}{invite.running ? '…' : '.'}
            {invite.failed.length > 0 && <div>Não deu para: {invite.failed.slice(0, 10).join(', ')}{invite.failed.length > 10 ? ` e mais ${invite.failed.length - 10}` : ''}</div>}
            {invite.error && <div>Ops, o envio parou: {invite.error}</div>}
          </div>}
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
