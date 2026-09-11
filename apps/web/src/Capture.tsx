import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardPaste, Plus, Search, Send, SlidersHorizontal, X } from 'lucide-react';
import { api } from './api';
import { parseOffers, toAffiliateUrl, type ParsedOffer } from './offers';

import { brl, parseBr, typingMoney, blurMoney } from './money';

/**
 * Fluxo em uma tela: colar → ofertas aparecem sozinhas → marcar grupos → enviar.
 * A regra de link de afiliado fica em Configurações, junto das demais credenciais.
 */
export default function Capture() {
  const [text, setText] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [term, setTerm] = useState('');
  const [onlyCoupon, setOnlyCoupon] = useState(false);
  // Toda oferta começa marcada; guardamos só as desmarcadas e as já importadas.
  const [unpicked, setUnpicked] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [suffix, setSuffix] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<any[]>([]);
  const [sendTo, setSendTo] = useState<Record<string, boolean>>({});
  const [fromTo, setFromTo] = useState(true);

  useEffect(() => {
    api.get('/api/channels').then(r => setChannels(r.data.filter((c: any) => c.enabled))).catch(() => {});
    api.get('/api/integrations/settings').then(r => {
      const find = (k: string) => r.data.settings.find((s: any) => s.key === k)?.masked || '';
      setSuffix({ SHOPEE: find('SHOPEE_AFFILIATE_SUFFIX'), MERCADO_LIVRE: find('ML_AFFILIATE_SUFFIX') });
    }).catch(() => {});
  }, []);

  const linkOf = (o: ParsedOffer) => toAffiliateUrl(o.productUrl, suffix[o.marketplace]);

  // Extração automática: sem botão "Extrair", o resultado acompanha o texto colado.
  const offers = useMemo(() => parseOffers(text).filter(o => !done[o.id]), [text, done]);

  const shown = useMemo(() => {
    const lo = parseBr(min);
    const hi = parseBr(max);
    const q = term.trim().toLowerCase();
    return offers.filter(o => {
      if (onlyCoupon && !o.coupon) return false;
      if (q && !o.title.toLowerCase().includes(q)) return false;
      if (lo !== undefined && (o.price ?? -1) < lo) return false;
      if (hi !== undefined && (o.price ?? Number.MAX_SAFE_INTEGER) > hi) return false;
      return true;
    });
  }, [offers, min, max, term, onlyCoupon]);

  const selected = shown.filter(o => !unpicked[o.id]);
  const targets = channels.filter(c => sendTo[c.id]);
  const filtering = !!(min || max || term || onlyCoupon);

  function clear() {
    setText(''); setUnpicked({}); setDone({}); setMsg('');
  }

  async function importSelected(andSend: boolean) {
    if (!selected.length) return setMsg('Marque ao menos uma oferta.');
    if (andSend && !targets.length) return setMsg('Escolha ao menos um grupo para enviar.');
    setBusy(true); setMsg('');
    let ok = 0; const fails: string[] = []; const ids: string[] = []; const doneNow: Record<string, boolean> = {};
    for (const o of selected) {
      try {
        const r = await api.post('/api/products/import/manual', {
          marketplace: o.marketplace === 'MERCADO_LIVRE' ? 'MERCADO_LIVRE' : 'SHOPEE',
          title: o.title,
          productUrl: o.productUrl,
          affiliateUrl: linkOf(o),
          price: o.price,
          oldPrice: o.oldPrice,
          couponText: o.coupon
        });
        ids.push(r.data.id); doneNow[o.id] = true; ok++;
      } catch (e: any) {
        fails.push(e?.response?.data?.error || o.title.slice(0, 30));
      }
    }
    let sent = 0;
    if (andSend && ids.length) {
      try {
        const r = await api.post('/api/offers/send-now', { productIds: ids, channelIds: targets.map(c => c.id), fromTo });
        sent = r.data.count;
      } catch (e: any) {
        fails.push(e?.response?.data?.error || 'Falha ao colocar os envios na fila.');
      }
    }
    setBusy(false);
    setDone(d => ({ ...d, ...doneNow }));
    setMsg(
      (sent ? `${ok} oferta(s) enviadas para ${targets.length} grupo(s).` : `${ok} oferta(s) salvas em Produtos.`) +
      (fails.length ? ` ${fails.length} falharam: ${fails[0]}` : '')
    );
  }

  return (
    <section className="page">
      <div className="page-title-row">
        <div>
          <h1>Capturar ofertas</h1>
          <p>Cole as mensagens do grupo. As ofertas aparecem abaixo, prontas para enviar.</p>
        </div>
      </div>

      <div className="card">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'Cole aqui as mensagens copiadas do grupo. Exemplo:\n\n🔥 Fone Bluetooth JBL Tune\nDe R$ 199,90 por R$ 89,90\nCupom: FONE10\nhttps://shopee.com.br/product/123/456'}
          style={{ minHeight: 150 }}
          autoFocus
        />
        <div className="capture-actions">
          {text
            ? <button className="outline" onClick={clear}><X size={16} /> Limpar</button>
            : <span className="hint" style={{ margin: 0 }}><ClipboardPaste size={15} /> Basta colar: não precisa clicar em nada.</span>}
          {!suffix.SHOPEE && !suffix.MERCADO_LIVRE && (
            <span className="hint" style={{ margin: 0 }}>Sem ID de afiliado salvo: os links vão como vieram. <Link to="/config">Configurar</Link></span>
          )}
        </div>
      </div>

      {text.trim() && (
        <div className="card">
          <div className="capture-head">
            <h2>{filtering ? `${shown.length} de ${offers.length}` : offers.length} oferta(s) · {selected.length} marcada(s)</h2>
            <div className="capture-actions" style={{ marginTop: 0 }}>
              <button className={`outline ${filtering ? 'is-on' : ''}`} onClick={() => setShowFilters(v => !v)}>
                <SlidersHorizontal size={16} /> Filtrar
              </button>
              {selected.length < shown.length
                ? <button className="outline" onClick={() => setUnpicked({})}>Marcar todas</button>
                : <button className="outline" onClick={() => setUnpicked(Object.fromEntries(shown.map(o => [o.id, true])))}>Desmarcar</button>}
            </div>
          </div>

          {showFilters && (
            <div className="form-row capture-filters">
              <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Buscar no nome" />
              <input value={min} inputMode="decimal" onChange={e => setMin(typingMoney(e.target.value))} onBlur={e => setMin(blurMoney(e.target.value))} placeholder="Preço mínimo: 10,00" />
              <input value={max} inputMode="decimal" onChange={e => setMax(typingMoney(e.target.value))} onBlur={e => setMax(blurMoney(e.target.value))} placeholder="Preço máximo: 150,00" />
              <label className="check-line" style={{ marginTop: 0 }}>
                <input type="checkbox" checked={onlyCoupon} onChange={e => setOnlyCoupon(e.target.checked)} />
                <span>Só com cupom</span>
              </label>
            </div>
          )}

          {shown.length ? (
            <div className="offer-list">
              {shown.map(o => (
                <label className={`offer-row ${unpicked[o.id] ? '' : 'on'}`} key={o.id}>
                  <input type="checkbox" checked={!unpicked[o.id]} onChange={e => setUnpicked(v => ({ ...v, [o.id]: !e.target.checked }))} />
                  <div className="offer-main">
                    <h3>{o.title}</h3>
                    <div className="offer-tags">
                      <span className="badge badge-off">{o.marketplace === 'MERCADO_LIVRE' ? 'Mercado Livre' : o.marketplace === 'SHOPEE' ? 'Shopee' : 'Outro'}</span>
                      {o.coupon && <span className="badge badge-ready">Cupom {o.coupon}</span>}
                      {!!o.discountPercent && <span className="badge badge-on">{o.discountPercent}% OFF</span>}
                    </div>
                    <a href={linkOf(o)} target="_blank" rel="noreferrer" className="offer-link" onClick={e => e.stopPropagation()}>{linkOf(o)}</a>
                  </div>
                  <div className="offer-price">
                    <strong>{brl(o.price)}</strong>
                    {o.oldPrice ? <small>{brl(o.oldPrice)}</small> : null}
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <div className="empty">
              <Search size={44} />
              <h2>{offers.length ? 'Nada dentro do filtro' : 'Nenhum link encontrado'}</h2>
              <p>{offers.length ? 'Ajuste o filtro para ver mais ofertas.' : 'Cada oferta precisa ter um link (Shopee, Mercado Livre...).'}</p>
            </div>
          )}
        </div>
      )}

      {offers.length > 0 && (
        <div className="card send-bar">
          <div className="send-bar-groups">
            <span className="send-bar-label"><Send size={16} /> Enviar para</span>
            {channels.length ? channels.map(c => (
              <button
                key={c.id}
                className={`chip-toggle ${sendTo[c.id] ? 'on' : ''}`}
                onClick={() => setSendTo(v => ({ ...v, [c.id]: !v[c.id] }))}
                title={c.type === 'WHATSAPP_GROUP' ? 'Grupo do WhatsApp' : c.type === 'WHATSAPP' ? 'Contato' : 'Instagram'}
              >{c.name}</button>
            )) : (
              <span className="hint" style={{ margin: 0 }}>Nenhum grupo ativo. <Link to="/channels">Conectar WhatsApp</Link></span>
            )}
          </div>
          <div className="capture-actions" style={{ marginTop: 0 }}>
            <label className="check-line" style={{ marginTop: 0, fontSize: 13.5 }} title="Mostra a linha DE R$ 199,90 acima do preço">
              <input type="checkbox" checked={fromTo} onChange={e => setFromTo(e.target.checked)} />
              <span>De X por Y</span>
            </label>
            <button className="outline" disabled={busy || !selected.length} onClick={() => importSelected(false)}>
              <Plus size={16} /> Só salvar
            </button>
            <button className="primary" disabled={busy || !selected.length || !targets.length} onClick={() => importSelected(true)}>
              <Send size={16} /> {busy ? 'Enviando...' : `Enviar ${selected.length} para ${targets.length} grupo(s)`}
            </button>
          </div>
          {msg && <b className="inline-msg send-bar-msg">{msg}</b>}
        </div>
      )}

      {!offers.length && msg && <div className="card"><b className="inline-msg">{msg}</b></div>}
    </section>
  );
}
