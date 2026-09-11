import { useEffect, useState } from 'react';
import { TicketPercent, Plus, Trash2, Send, Power, RefreshCw, ClipboardPaste, MessageCircle, Instagram, Clock3, Zap } from 'lucide-react';
import { api } from './api';
import { notify } from './notify';
import { brl, typingMoney, blurMoney } from './money';
import { previewOffer } from './offerPreview';

/**
 * Cupons da Shopee e do Mercado Livre.
 * Nenhuma das duas dá cupom por API, então o usuário cadastra (ou cola a lista do Telegram,
 * ou aponta um canal público para importar sozinho). O "listão" de cada marketplace sai para
 * os grupos no intervalo escolhido, só com cupons válidos, e com o link do usuário.
 */

type Mkt = 'SHOPEE' | 'MERCADO_LIVRE';
const MKTS: Mkt[] = ['MERCADO_LIVRE', 'SHOPEE'];
const mktName = (m: Mkt) => (m === 'SHOPEE' ? 'Shopee' : 'Mercado Livre');
const mktIcon = (m: Mkt) => (m === 'SHOPEE' ? '🛍️' : '🟡');
const INTERVALS = [[0, 'Não envia sozinho'], [60, '1 h'], [120, '2 h'], [180, '3 h'], [240, '4 h'], [360, '6 h']] as const;

const dateInput = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : '');
const brDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' }) : '');
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null);

export default function Coupons() {
  const [data, setData] = useState<{ coupons: any[]; schedules: Record<string, any> }>({ coupons: [], schedules: {} });
  const [channels, setChannels] = useState<any[]>([]);
  const [mkt, setMkt] = useState<Mkt>('MERCADO_LIVRE');
  const [busy, setBusy] = useState('');
  const load = () => api.get('/api/coupons').then(r => setData(r.data)).catch(() => {});
  useEffect(() => { load(); api.get('/api/channels').then(r => setChannels(r.data.filter((c: any) => c.enabled))).catch(() => {}); }, []);

  const sch = data.schedules[mkt];
  const coupons = data.coupons.filter(c => c.marketplace === mkt);

  async function saveSchedule(patch: any) {
    try { const r = await api.put(`/api/coupons/schedule/${mkt}`, patch); setData(r.data); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível salvar a agenda.', 'error'); }
  }
  async function sendNow() {
    setBusy('send');
    try { const r = await api.post(`/api/coupons/send/${mkt}`); notify(`Listão ${mktName(mkt)} enviado para ${r.data.count} grupo(s).`); load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível enviar.', 'error'); }
    finally { setBusy(''); }
  }
  async function importNow() {
    setBusy('import');
    try {
      const r = await api.post(`/api/coupons/import-telegram/${mkt}`, { channel: sch?.telegramChannel });
      notify(`Telegram: ${r.data.total} cupom(ns) na última mensagem, ${r.data.added} novo(s), ${r.data.removed} removido(s).`);
      setData({ coupons: r.data.coupons, schedules: r.data.schedules });
    } catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível importar do Telegram.', 'error'); }
    finally { setBusy(''); }
  }
  async function patchCoupon(c: any, patch: any) {
    try { await api.patch(`/api/coupons/${c.id}`, patch); load(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível alterar o cupom.', 'error'); }
  }
  async function removeCoupon(c: any) {
    if (!confirm(`Excluir o cupom ${c.code}?`)) return;
    try { await api.delete(`/api/coupons/${c.id}`); load(); }
    catch { notify('Não foi possível excluir.', 'error'); }
  }

  return <section className="page">
    <div className="page-title-row"><div><h1>Cupons</h1><p>Cadastre os cupons que você pegou e o robô manda o listão para os grupos no intervalo escolhido, só com cupons válidos e com o seu link. Nem a Shopee nem o Mercado Livre entregam cupom por API.</p></div></div>

    <div className="choice-grid choice-grid-tight" style={{ maxWidth: 480 }}>
      {MKTS.map(m => <button key={m} type="button" className={mkt === m ? 'chosen' : ''} onClick={() => setMkt(m)}>{mktIcon(m)} {mktName(m)} <small className="muted" style={{ margin: 0 }}>({data.coupons.filter(c => c.marketplace === m && c.enabled && !c.expired).length} válidos)</small></button>)}
    </div>

    {sch && <div className="card">
      <div className="card-head"><div><Clock3 size={20} /><h3>Listão {mktName(mkt)}</h3></div><span className={`badge ${sch.enabled && sch.everyMinutes ? 'badge-on' : 'badge-off'}`}>{sch.enabled && sch.everyMinutes ? 'Agendado' : 'Manual'}</span></div>
      <p className="muted">{sch.everyMinutes ? <>Dispara {sch.next}</> : 'Só pelo botão "Enviar listão agora".'}{sch.lastSentAt ? ` · último ${when(sch.lastSentAt)}` : ' · ainda não enviou'} · {sch.usable} cupom(ns) válido(s){` · vai para ${(sch.groups || []).length} grupo(s)${(sch.groups || []).length ? ': ' + sch.groups.map((g: any) => g.name).join(', ') : ''}`}</p>

      <label>Intervalo entre envios</label>
      <div className="niche-grid">{INTERVALS.map(([v, l]) => <button key={v} type="button" className={sch.everyMinutes === v ? 'chosen' : ''} onClick={() => saveSchedule({ everyMinutes: v })}>{l}</button>)}</div>
      <div className="search-opts">
        <div><label>Começa às</label><input type="time" value={sch.startTime} onChange={e => saveSchedule({ startTime: e.target.value })} /></div>
        <div><label>Termina às</label><input type="time" value={sch.endTime} onChange={e => saveSchedule({ endTime: e.target.value })} /></div>
      </div>

      <label>Grupos que recebem o listão</label>
      {channels.length ? <div className="niche-grid"><button type="button" className={(sch.channelIds || []).length ? '' : 'chosen'} title="Vai para os grupos das automações deste marketplace; grupo novo entra sozinho" onClick={() => saveSchedule({ channelIds: [] })}><Zap size={14} /> Automático</button>{channels.map(c => { const on = (sch.channelIds || []).includes(c.id); return <button key={c.id} type="button" className={on ? 'chosen' : ''} onClick={() => saveSchedule({ channelIds: on ? (sch.channelIds || []).filter((x: string) => x !== c.id) : [...(sch.channelIds || []), c.id] })}>{c.type === 'INSTAGRAM' ? <Instagram size={14} /> : <MessageCircle size={14} />} {c.name}</button>; })}</div> : <p className="hint">Nenhum canal ativo. Conecte o WhatsApp em Canais.</p>}
      {(sch.channelIds || []).length
        ? <p className="hint">Só os grupos marcados recebem. Clique em <b>Automático</b> para voltar a seguir as automações {mktName(mkt)}.</p>
        : <p className="hint"><b>Automático:</b> o listão vai para os grupos das automações {mktName(mkt)} ativas{sch.groups?.length ? <> (hoje: {sch.groups.map((g: any) => g.name).join(', ')})</> : ' (nenhum ainda)'}. Grupo novo entra sozinho assim que for usado numa automação {mktName(mkt)}. Cupom do Mercado Livre nunca cai em grupo Shopee, e vice-versa.</p>}

      <label>Seu link {mkt === 'SHOPEE' ? 'da carteira de cupons Shopee' : 'de afiliado do Mercado Livre'} (vai no fim do listão)</label>
      <LinkField value={sch.link || ''} onSave={v => saveSchedule({ link: v })} placeholder={mkt === 'SHOPEE' ? 'https://shopee.com.br/user/voucher-wallet?...&utm_source=an_SEUID' : 'https://www.mercadolivre.com.br/cupons?matt_tool=SEUID'} />
      <p className="hint">Use o SEU link. O link que vem nas listas do Telegram é de outro afiliado e não conta comissão para você.</p>

      <label>Canal público do Telegram para importar sozinho (opcional)</label>
      <div className="form-row form-row-tight">
        <LinkField value={sch.telegramChannel || ''} onSave={v => saveSchedule({ telegramChannel: v })} placeholder="melicupons" />
        <button type="button" className="outline" disabled={busy === 'import' || !sch.telegramChannel} onClick={importNow}><RefreshCw size={16} /> {busy === 'import' ? 'Importando...' : 'Importar agora'}</button>
      </div>
      <p className="hint">Antes de cada envio o robô lê a última mensagem do canal e deixa os cupons importados iguais a ela. Cupons que você digitou não mudam.</p>

      <label>Prévia do listão</label>
      <div className="wa-bubble" aria-label="Prévia do listão">{previewOffer(sch.text)}</div>
      <div className="card-actions">
        <button className="outline" onClick={() => saveSchedule({ enabled: !sch.enabled })}><Power size={16} /> {sch.enabled ? 'Pausar agenda' : 'Ativar agenda'}</button>
        <button className="primary" disabled={busy === 'send'} onClick={sendNow}><Send size={16} /> {busy === 'send' ? 'Enviando...' : 'Enviar listão agora'}</button>
      </div>
    </div>}

    <AddCoupon mkt={mkt} onDone={load} />
    <PasteList mkt={mkt} onDone={load} />

    {coupons.length ? <div className="card">
      <div className="card-head"><div><TicketPercent size={20} /><h3>Cupons {mktName(mkt)}</h3></div><span className="badge badge-off">{coupons.length}</span></div>
      <div className="line-products">
        {coupons.map(c => <div className="line-product" key={c.id} style={{ opacity: c.enabled && !c.expired ? 1 : .55 }}>
          <div className="line-product-main">
            <b>🏷️ {c.code} {c.expired ? <span className="badge badge-off">Vencido</span> : !c.enabled ? <span className="badge badge-off">Pausado</span> : <span className="badge badge-on">Válido</span>} {c.source === 'TELEGRAM' && <span className="badge badge-ready" title={c.sourceRef}>Telegram</span>}</b>
            <small>{c.description || 'sem descrição'}{c.minPrice ? ` · mínimo ${brl(c.minPrice)}` : ''}{c.validUntil ? ` · até ${brDate(c.validUntil)}` : ' · sem validade'}</small>
            <div className="form-row form-row-tight" style={{ marginTop: 6 }}>
              <label className="check-line" style={{ margin: 0 }}><input type="checkbox" checked={!!c.inProducts} onChange={e => patchCoupon(c, { inProducts: e.target.checked })} /><span>Também nas mensagens de produto</span></label>
              <input type="date" title="Validade" value={dateInput(c.validUntil)} onChange={e => patchCoupon(c, { validUntil: e.target.value || null })} style={{ maxWidth: 170 }} />
            </div>
          </div>
          <button className="icon-btn" title={c.enabled ? 'Pausar' : 'Ativar'} onClick={() => patchCoupon(c, { enabled: !c.enabled })}><Power size={16} /></button>
          <button className="icon-btn" title="Excluir cupom" onClick={() => removeCoupon(c)}><Trash2 size={16} /></button>
        </div>)}
      </div>
    </div> : <div className="card"><div className="empty"><TicketPercent size={48} /><h2>Nenhum cupom {mktName(mkt)}</h2><p>Cadastre acima, cole a lista do Telegram ou informe um canal para importar sozinho.</p></div></div>}
  </section>;
}

/** Campo de texto que salva ao sair (blur) ou no Enter, para não disparar um PUT por tecla. */
function LinkField({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value) onSave(v.trim()); };
  return <input value={v} onChange={e => setV(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} placeholder={placeholder} />;
}

function AddCoupon({ mkt, onDone }: { mkt: Mkt; onDone: () => void }) {
  const [code, setCode] = useState(''); const [desc, setDesc] = useState(''); const [min, setMin] = useState(''); const [until, setUntil] = useState(''); const [inProducts, setInProducts] = useState(false);
  async function add() {
    if (code.trim().length < 3) return notify('Digite o código do cupom.', 'error');
    try {
      await api.post('/api/coupons', { marketplace: mkt, code: code.trim(), description: desc || null, minPrice: min || undefined, validUntil: until || null, inProducts });
      setCode(''); setDesc(''); setMin(''); setUntil(''); notify('Cupom cadastrado.'); onDone();
    } catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível cadastrar.', 'error'); }
  }
  return <div className="card">
    <div className="card-head"><div><Plus size={20} /><h3>Novo cupom {mktName(mkt)}</h3></div></div>
    <div className="form-row">
      <input value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Código (ex.: VALEMAIS)" style={{ maxWidth: 200 }} />
      <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Descrição (ex.: 10% OFF acima de R$79, limite R$100)" />
      <input value={min} inputMode="decimal" onChange={e => setMin(typingMoney(e.target.value))} onBlur={e => setMin(blurMoney(e.target.value))} placeholder="Compra mínima R$" style={{ maxWidth: 160 }} />
      <input type="date" value={until} onChange={e => setUntil(e.target.value)} title="Válido até" style={{ maxWidth: 170 }} />
      <button className="primary" onClick={add}><Plus size={18} /> Adicionar</button>
    </div>
    <label className="check-line"><input type="checkbox" checked={inProducts} onChange={e => setInProducts(e.target.checked)} /><span>Também colocar na linha "Cupom" das mensagens de produto {mktName(mkt)} (quando o preço atinge a compra mínima)</span></label>
    <p className="hint">Sem validade, o cupom fica até você pausar ou excluir. Com validade, para de sair sozinho no dia seguinte.</p>
  </div>;
}

function PasteList({ mkt, onDone }: { mkt: Mkt; onDone: () => void }) {
  const [open, setOpen] = useState(false); const [text, setText] = useState(''); const [items, setItems] = useState<any[] | null>(null); const [sel, setSel] = useState<Record<string, boolean>>({}); const [until, setUntil] = useState(''); const [busy, setBusy] = useState(false);
  async function parse() {
    setBusy(true);
    try { const r = await api.post('/api/coupons/parse', { text }); setItems(r.data.coupons); setSel(Object.fromEntries(r.data.coupons.map((c: any) => [c.code, true]))); if (!r.data.coupons.length) notify('Não reconheci nenhum cupom nesse texto.', 'error'); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível ler o texto.', 'error'); }
    finally { setBusy(false); }
  }
  async function save() {
    const chosen = (items || []).filter(c => sel[c.code]);
    if (!chosen.length) return notify('Marque pelo menos um cupom.', 'error');
    setBusy(true);
    try { const r = await api.post('/api/coupons/bulk', { marketplace: mkt, validUntil: until || null, items: chosen }); notify(`${r.data.count} cupom(ns) salvos${r.data.skipped ? `, ${r.data.skipped} já existiam` : ''}.`); setText(''); setItems(null); setOpen(false); onDone(); }
    catch (e: any) { notify(e?.response?.data?.error || 'Não foi possível salvar.', 'error'); }
    finally { setBusy(false); }
  }
  if (!open) return <div className="card"><div className="card-actions" style={{ justifyContent: 'flex-start' }}><button className="outline" onClick={() => setOpen(true)}><ClipboardPaste size={16} /> Colar lista de cupons (Telegram, WhatsApp)</button><span className="muted">Reconhece "🎟️ CÓDIGO - 10% OFF" e "descrição: CÓDIGO".</span></div></div>;
  return <div className="card">
    <div className="card-head"><div><ClipboardPaste size={20} /><h3>Colar lista de cupons {mktName(mkt)}</h3></div></div>
    <textarea value={text} onChange={e => setText(e.target.value)} rows={8} placeholder={'Cole aqui a mensagem. Ex.:\n🎟️ VALEMAIS - 10% OFF\nacima de R$79 máximo R$100\n\nou\n\n10% OFF acima de R$79, limite R$100: VALEMAIS'} style={{ width: '100%' }} />
    <div className="card-actions" style={{ justifyContent: 'flex-start' }}>
      <button className="outline" disabled={busy || text.trim().length < 3} onClick={parse}>{busy ? 'Lendo...' : 'Ler cupons'}</button>
      <button className="link-btn" onClick={() => { setOpen(false); setItems(null); }}>cancelar</button>
    </div>
    {items && items.length > 0 && <>
      <div className="line-products">{items.map(c => <label className="line-product" key={c.code} style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!sel[c.code]} onChange={e => setSel(s => ({ ...s, [c.code]: e.target.checked }))} /><div className="line-product-main"><b>{c.code}</b><small>{c.description || 'sem descrição'}{c.minPrice ? ` · mínimo ${brl(c.minPrice)}` : ''}</small></div></label>)}</div>
      <div className="form-row form-row-tight" style={{ marginTop: 10 }}>
        <label style={{ margin: 0 }}>Validade para todos (opcional)</label><input type="date" value={until} onChange={e => setUntil(e.target.value)} style={{ maxWidth: 170 }} />
        <button className="primary" disabled={busy} onClick={save}><Plus size={16} /> Salvar {Object.values(sel).filter(Boolean).length} cupom(ns)</button>
      </div>
      <p className="hint">O link que vier na mensagem é ignorado: no listão sai o seu, configurado acima.</p>
    </>}
  </div>;
}
