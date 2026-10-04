import { useEffect, useState } from 'react';
import { Download, FileUp, Link2, Send, UserPlus, Users } from 'lucide-react';
import { api } from './api';

type Group = { id: string; name: string; participants: number };
type Invite = { total: number; sent: number; failed: string[]; running: boolean; error: string | null };
type Copy = { fromName: string; toId?: string; toName: string; invite?: Invite | null; batch?: number; pauseSec?: number; total: number; done: number; added: number; already: number; privacy: string[]; failed: string[]; noPhone: number; running: boolean; error: string | null; finishedAt: string | null };

function downloadCsv(fileName: string, rows: string[][]) {
  // BOM para o Excel abrir os acentos certinho; ";" é o separador que o Excel em português espera.
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

const safeName = (s: string) => s.replace(/[\/:*?"<>|]+/g, '').trim() || 'grupo';

// Intervalos entre um lote e outro; quanto maior, menor o risco de o WhatsApp bloquear o número.
const PAUSES = [30, 60, 120, 300, 600, 900, 1800, 3600];
const fmtPause = (s: number) => s < 60 ? `${s} segundos` : s === 60 ? '1 minuto' : s < 3600 ? `${s / 60} minutos` : '1 hora';

/** Tempo aproximado até terminar, para mostrar antes de começar. */
function fmtTotal(people: number, batch: number, pauseSec: number) {
  const min = Math.ceil((Math.max(0, Math.ceil(people / batch) - 1) * pauseSec) / 60);
  if (min < 1) return 'menos de 1 minuto';
  if (min < 60) return `uns ${min} minuto(s)`;
  const h = Math.floor(min / 60), m = min % 60;
  return `umas ${h}h${m ? String(m).padStart(2, '0') : ''}`;
}

/**
 * Telefones de um CSV/TXT: pega o primeiro campo de cada linha que pareça telefone.
 * Com 10 ou 11 dígitos (DDD + número) assume Brasil e põe o 55 na frente.
 */
function parsePhones(text: string) {
  const phones = new Set<string>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let found = '';
    for (const cell of line.split(/[;,\t]/)) {
      const d = cell.replace(/\D/g, '');
      if (/^\d{10,11}$/.test(d) && !d.startsWith('55')) { found = `55${d}`; break; }
      if (/^\d{12,15}$/.test(d)) { found = d; break; }
      if (/^55\d{10,11}$/.test(d)) { found = d; break; }
    }
    if (found) phones.add(found); else skipped++;
  }
  return { phones: [...phones], skipped };
}

// {grupo} e {link} são trocados pelo servidor na hora de mandar.
const DEFAULT_INVITE = 'Oi, tudo bem? 😊 Tentei te adicionar no grupo *{grupo}*, mas a privacidade do seu WhatsApp não deixou. Se quiser entrar e receber as ofertas, é só tocar no link:\n{link}\n\nQualquer dúvida, estou por aqui!';

/** Extrai os contatos de um grupo em planilha ou adiciona os membros de um grupo em outro. */
export default function GroupContacts({ groups }: { groups: Group[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<Copy | null>(null);
  const [batch, setBatch] = useState(5);
  const [pauseSec, setPauseSec] = useState(30);
  const [inviteText, setInviteText] = useState(DEFAULT_INVITE);
  const [file, setFile] = useState<File | null>(null);

  const loadCopy = () => api.get('/api/whatsapp/groups/copy').then(r => setCopy(r.data || null)).catch(() => {});
  useEffect(() => { loadCopy(); }, []);
  // Enquanto a importação ou os convites rodam, atualiza o progresso a cada 5s.
  const working = !!copy?.running || !!copy?.invite?.running;
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(loadCopy, 5000);
    return () => window.clearInterval(t);
  }, [working]);

  async function inviteLink(groupId: string) {
    const r = await api.get(`/api/whatsapp/groups/${encodeURIComponent(groupId)}/invite`);
    return r.data.link as string;
  }

  async function copyLink() {
    if (!to) return setMsg('Escolha o grupo de destino.');
    setBusy(true); setMsg('');
    try {
      const link = await inviteLink(to);
      try { await navigator.clipboard.writeText(link); setMsg(`Link copiado! É só colar na conversa com o cliente: ${link}`); }
      catch { setMsg(`Link do grupo: ${link}`); }
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível pegar o link de convite.'); }
    finally { setBusy(false); }
  }

  async function sendInvites() {
    if (!copy) return;
    if (!inviteText.includes('{link}')) return setMsg('A mensagem precisa ter {link} no lugar do link do grupo.');
    if (!confirm(`Mandar o convite no privado para ${copy.privacy.length} pessoa(s)?\n\nVai uma mensagem de cada vez, com uns 30 segundos entre elas, para proteger o número.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy/invite', { text: inviteText }); setCopy(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || e?.response?.data?.issues?.[0]?.message || 'Não foi possível mandar os convites.'); }
    finally { setBusy(false); }
  }

  async function downloadLeftOut() {
    if (!copy) return;
    // Tenta pôr o link na planilha para facilitar mandar à mão; se não der, baixa sem ele.
    let link = '';
    if (copy.toId) { try { link = await inviteLink(copy.toId); } catch {} }
    downloadCsv(`nao adicionados - ${safeName(copy.toName)}.csv`, [
      ['Telefone', 'Motivo', 'Link do grupo'],
      ...copy.privacy.map(p => [`+${p}`, 'privacidade (mandar convite)', link]),
      ...copy.failed.map(p => [`+${p}`, 'erro', link]),
    ]);
  }

  async function extract() {
    if (!from) return setMsg('Escolha o grupo de origem.');
    setBusy(true); setMsg('');
    try {
      const r = await api.get(`/api/whatsapp/groups/${encodeURIComponent(from)}/members`);
      const members: { jid: string; phone: string | null; admin: boolean }[] = r.data.members;
      downloadCsv(`contatos - ${safeName(r.data.name)}.csv`, [['Telefone', 'Administrador'], ...members.map(m => [m.phone ? `+${m.phone}` : '(número oculto)', m.admin ? 'sim' : 'não'])]);
      const hidden = members.filter(m => !m.phone).length;
      setMsg(`Pronto! ${members.length} contato(s) baixados${hidden ? ` (${hidden} com número oculto pelo WhatsApp)` : ''}.`);
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível extrair os contatos.'); }
    finally { setBusy(false); }
  }

  async function importTo() {
    if (!from || !to) return setMsg('Escolha o grupo de origem e o de destino.');
    if (from === to) return setMsg('Escolha grupos diferentes.');
    const src = groups.find(g => g.id === from), d = groups.find(g => g.id === to)?.name;
    const size = Math.min(20, Math.max(1, Math.round(batch) || 5));
    if (!confirm(`Adicionar os membros de "${src?.name}" no grupo "${d}"?\n\nVocê precisa ser administrador de "${d}". Vão entrar ${size} pessoa(s) a cada ${fmtPause(pauseSec)} — com ${src?.participants || 0} membros, leva ${fmtTotal(src?.participants || 0, size, pauseSec)}.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy', { from, to, batch: size, pauseSec }); setCopy(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível iniciar a importação.'); }
    finally { setBusy(false); }
  }

  async function importFile() {
    if (!file) return setMsg('Escolha o arquivo com os telefones.');
    if (!to) return setMsg('Escolha o grupo de destino.');
    const { phones, skipped } = parsePhones(await file.text());
    if (!phones.length) return setMsg('Não achei nenhum telefone no arquivo. Coloque um número por linha, com DDD (ex.: 11 91234-5678).');
    const d = groups.find(g => g.id === to)?.name;
    const size = Math.min(20, Math.max(1, Math.round(batch) || 5));
    if (!confirm(`Adicionar ${phones.length} telefone(s) do arquivo "${file.name}" no grupo "${d}"?${skipped ? `\n(${skipped} linha(s) sem telefone válido foram ignoradas.)` : ''}\n\nVocê precisa ser administrador de "${d}". Vão entrar ${size} pessoa(s) a cada ${fmtPause(pauseSec)} — leva ${fmtTotal(phones.length, size, pauseSec)}.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy', { phones, fileName: file.name, to, batch: size, pauseSec }); setCopy(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível iniciar a importação.'); }
    finally { setBusy(false); }
  }

  const pct = copy && copy.total ? Math.round((copy.done / copy.total) * 100) : 100;

  return (
    <div style={{ marginTop: 22 }}>
      <div className="card-head"><div><Users size={20} /><h3>Contatos dos grupos</h3></div></div>
      <p className="muted">Baixe os contatos de um grupo em planilha ou importe para outro grupo os membros de um grupo ou de um arquivo CSV.</p>
      <div className="form-row form-row-tight">
        <select value={from} onChange={e => setFrom(e.target.value)}>
          <option value="">Grupo de origem</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.participants})</option>)}
        </select>
        <button className="outline" disabled={busy || !from} onClick={extract}><Download size={16} /> Extrair contatos</button>
      </div>
      <div className="form-row form-row-tight">
        <select value={to} onChange={e => setTo(e.target.value)}>
          <option value="">Grupo de destino</option>
          {groups.filter(g => g.id !== from).map(g => <option key={g.id} value={g.id}>{g.name} ({g.participants})</option>)}
        </select>
        <button className="primary" disabled={busy || !from || !to || !!copy?.running} onClick={importTo}><UserPlus size={16} /> Importar para o destino</button>
      </div>
      <div className="form-row form-row-tight">
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button className="primary" disabled={busy || !file || !to || !!copy?.running} onClick={importFile}><FileUp size={16} /> Importar arquivo para o destino</button>
      </div>
      <p className="hint">O arquivo pode ser a planilha baixada em "Extrair contatos" ou um CSV/TXT com um telefone por linha, com DDD. Sem o 55 na frente, entende como número do Brasil.</p>
      <div className="form-row form-row-tight">
        <label>Pessoas por vez
          <input type="number" min={1} max={20} value={batch} onChange={e => setBatch(Number(e.target.value))} />
        </label>
        <label>Esperar entre cada vez
          <select value={pauseSec} onChange={e => setPauseSec(Number(e.target.value))}>
            {PAUSES.map(s => <option key={s} value={s}>{fmtPause(s)}</option>)}
          </select>
        </label>
        <button className="outline" disabled={busy || !to} onClick={copyLink}><Link2 size={16} /> Copiar link do grupo</button>
      </div>
      <p className="hint">Só funciona se você for administrador do grupo de destino. Quem bloqueou ser adicionado por desconhecidos (privacidade) não entra direto — no fim da importação dá para mandar o link de convite no privado deles.</p>

      {copy && (
        <div className="inline-msg">
          <b>{copy.running ? 'Importando' : 'Importação'}: {copy.fromName} → {copy.toName}</b>
          {copy.running && <div>{copy.done} de {copy.total} ({pct}%)…{copy.batch && copy.pauseSec ? ` ${copy.batch} pessoa(s) a cada ${fmtPause(copy.pauseSec)}, faltam ${fmtTotal(copy.total - copy.done, copy.batch, copy.pauseSec)}.` : ''}</div>}
          <div>{copy.added} adicionado(s) · {copy.already} já estavam no grupo{copy.privacy.length ? ` · ${copy.privacy.length} bloqueados pela privacidade` : ''}{copy.failed.length ? ` · ${copy.failed.length} com erro` : ''}{copy.noPhone ? ` · ${copy.noPhone} com número oculto` : ''}</div>
          {copy.error && <div>Ops, a importação parou: {copy.error}</div>}
          {!copy.running && (copy.privacy.length + copy.failed.length) > 0 && (
            <button className="outline" style={{ marginTop: 8 }} onClick={downloadLeftOut}>
              <Download size={16} /> Baixar os que não entraram
            </button>
          )}
          {copy.invite && (
            <div style={{ marginTop: 8 }}>
              <b>Convites no privado:</b> {copy.invite.sent} de {copy.invite.total} enviado(s){copy.invite.failed.length ? ` · ${copy.invite.failed.length} com erro` : ''}{copy.invite.running ? '…' : '.'}
              {copy.invite.error && <div>Ops, o envio parou: {copy.invite.error}</div>}
            </div>
          )}
          {!copy.running && copy.privacy.length > 0 && !copy.invite?.running && (
            <div style={{ marginTop: 10 }}>
              <label>Mensagem do convite (use {'{grupo}'} e {'{link}'})
                <textarea rows={5} value={inviteText} onChange={e => setInviteText(e.target.value)} />
              </label>
              <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={sendInvites}>
                <Send size={16} /> {copy.invite ? 'Mandar convite de novo' : 'Mandar convite no privado'} ({copy.privacy.length})
              </button>
            </div>
          )}
        </div>
      )}
      {msg && <p className="inline-msg">{msg}</p>}
    </div>
  );
}
