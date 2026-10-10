import { useEffect, useState } from 'react';
import { Download, FileUp, Link2, Play, Send, Square, UserPlus, Users, X } from 'lucide-react';
import { api } from './api';
import { parsePhones } from './phones';

// sessions/admins: ids dos números conectados que estão no grupo e quais deles são administradores.
type Group = { id: string; name: string; participants: number; sessions?: string[]; admins?: string[] };
type Session = { id: string; phone: string };
type Invite = { total: number; sent: number; failed: string[]; running: boolean; error: string | null };
type Copy = { fromName: string; toId: string; toName: string; invite?: Invite | null; autoInvite?: boolean; batch?: number; pauseSec?: number; dailyLimit?: number; waitingUntil?: string | null; waitingConnection?: boolean; warmingUntil?: string | null; stopped?: boolean; total: number; done: number; added: number; already: number; privacy: string[]; failed: string[]; failReasons?: Record<string, string>; skippedBefore?: number; noPhone: number; running: boolean; error: string | null; finishedAt: string | null; left?: number; session?: string | null; sessionPhone?: string | null; tempContacts?: boolean };

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

/** Igual ao fmtTotal, mas respeitando o limite por dia (o que passa do limite fica para os dias seguintes). */
function fmtPlan(people: number, batch: number, pauseSec: number, limit: number, usedToday: number) {
  const room = Math.max(0, limit - usedToday);
  if (people <= room) return fmtTotal(people, batch, pauseSec);
  const moreDays = Math.ceil((people - room) / limit);
  return `${moreDays + (room ? 1 : 0)} dia(s), porque o limite é de ${limit} por dia: ${room ? `hoje entram ${room}, ` : 'hoje o limite já acabou, '}depois ${limit} por dia, e continua sozinho a cada virada do dia`;
}

// {grupo} e {link} são trocados pelo servidor na hora de mandar.
const DEFAULT_INVITE = 'Oi, tudo bem? 😊 Tentei te adicionar no grupo *{grupo}*, mas a privacidade do seu WhatsApp não deixou. Se quiser entrar e receber as ofertas, é só tocar no link:\n{link}\n\nQualquer dúvida, estou por aqui!';

const leftOf = (c: Copy) => c.left ?? c.total - c.done;

/** Extrai os contatos de um grupo em planilha ou adiciona os membros de um grupo em outro. sessions: números conectados. */
// cautious: começa com ritmo mais calmo (tela do número descartável, que costuma ser um chip novo).
export default function GroupContacts({ groups, sessions, cautious = false }: { groups: Group[]; sessions: Session[]; cautious?: boolean }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Número que faz a adição (pedido do usuário em 2026-10-08): só os que estão no grupo de destino.
  const [via, setVia] = useState('');
  // Salvar na agenda temporariamente antes de adicionar (quem tem privacidade "só meus contatos" aceita assim).
  const [tempContacts, setTempContacts] = useState(true);
  const multi = sessions.length > 1;
  /** Números conectados que estão no grupo (sem a informação, todos), administradores primeiro. */
  const candidatesFor = (groupId: string) => {
    const g = groups.find(x => x.id === groupId);
    const inGroup = g?.sessions?.length ? sessions.filter(s => g.sessions!.includes(s.id)) : sessions;
    return [...inGroup].sort((a, b) => Number(!!g?.admins?.includes(b.id)) - Number(!!g?.admins?.includes(a.id)));
  };
  const isAdmin = (groupId: string, id: string) => !!groups.find(x => x.id === groupId)?.admins?.includes(id);
  const phoneLabel = (groupId: string, s: Session) => `+${s.phone}${isAdmin(groupId, s.id) ? ' (administrador)' : ''}`;
  // Ao trocar o destino, sugere o número administrador dele.
  useEffect(() => { setVia(candidatesFor(to)[0]?.id || ''); }, [to, groups.length, sessions.length]);
  const candidates = candidatesFor(to);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // Uma importação por grupo de destino; várias podem rodar ao mesmo tempo.
  const [copies, setCopies] = useState<Copy[]>([]);
  const [batch, setBatch] = useState(cautious ? 3 : 5);
  const [pauseSec, setPauseSec] = useState(cautious ? 60 : 30);
  const [dailyLimit, setDailyLimit] = useState(cautious ? 30 : 50);
  const [addedToday, setAddedToday] = useState(0);
  const [inviteText, setInviteText] = useState(DEFAULT_INVITE);
  const [autoInvite, setAutoInvite] = useState(true);
  const [file, setFile] = useState<File | null>(null);

  // A API devolve todas as importações ({ jobs, addedToday }).
  const applyCopies = (data: any) => { setAddedToday(data?.addedToday || 0); setCopies(Array.isArray(data?.jobs) ? data.jobs : []); };
  const loadCopy = () => api.get('/api/whatsapp/groups/copy').then(r => applyCopies(r.data)).catch((e: any) => setMsg(e?.response?.data?.error || 'Não consegui carregar as importações. Atualize a página em instantes.'));
  useEffect(() => { loadCopy(); }, []);
  // Enquanto alguma importação ou convite roda, atualiza o progresso a cada 5s.
  const working = copies.some(c => c.running || c.invite?.running);
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(loadCopy, 5000);
    return () => window.clearInterval(t);
  }, [working]);

  async function inviteLink(groupId: string, session?: string | null) {
    const r = await api.get(`/api/whatsapp/groups/${encodeURIComponent(groupId)}/invite${session ? `?session=${session}` : ''}`);
    return r.data.link as string;
  }

  async function copyLink() {
    if (!to) return setMsg('Escolha o grupo de destino.');
    setBusy(true); setMsg('');
    try {
      const link = await inviteLink(to, via);
      try { await navigator.clipboard.writeText(link); setMsg(`Link copiado! É só colar na conversa com o cliente: ${link}`); }
      catch { setMsg(`Link do grupo: ${link}`); }
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível pegar o link de convite.'); }
    finally { setBusy(false); }
  }

  async function stopCopy(copy: Copy) {
    if (!confirm(`Parar a importação para "${copy.toName}"? Quem já entrou continua no grupo.`)) return;
    setBusy(true);
    try { const r = await api.post('/api/whatsapp/groups/copy/stop', { to: copy.toId }); applyCopies(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível parar a importação.'); }
    finally { setBusy(false); }
  }

  // Limite por dia digitado no quadro de cada importação, por grupo de destino (sem valor = ainda é o da própria importação).
  const [jobLimits, setJobLimits] = useState<Record<string, number>>({});
  const setJobLimit = (toId: string, n: number | null) => setJobLimits(m => { const c = { ...m }; if (n == null) delete c[toId]; else c[toId] = n; return c; });
  const cleanLimit = (n: number) => Math.min(1000, Math.max(1, Math.round(n) || 50));
  // Número escolhido no quadro de cada importação parada (sem valor = o da própria importação, se ainda estiver no grupo).
  const [jobVias, setJobVias] = useState<Record<string, string>>({});
  const viaFor = (copy: Copy) => { const c = candidatesFor(copy.toId); const want = jobVias[copy.toId] || copy.session || ''; return c.some(s => s.id === want) ? want : c[0]?.id || ''; };

  /** Troca o limite por dia de uma importação que está rodando; se ela esperava a meia-noite e o limite novo deixa espaço, volta na hora. */
  async function changeLimit(copy: Copy) {
    const jobLimit = jobLimits[copy.toId];
    if (jobLimit == null) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy/settings', { to: copy.toId, dailyLimit: cleanLimit(jobLimit) }); applyCopies(r.data); setJobLimit(copy.toId, null); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível mudar o limite.'); }
    finally { setBusy(false); }
  }

  /** Continua de onde parou uma importação parada, com o limite por dia escolhido no quadro dela. */
  async function resumeCopy(copy: Copy) {
    const limit = cleanLimit(jobLimits[copy.toId] ?? copy.dailyLimit ?? dailyLimit);
    const left = leftOf(copy);
    const session = viaFor(copy) || undefined;
    const phone = sessions.find(s => s.id === session)?.phone;
    if (!confirm(`Continuar a importação para "${copy.toName}" de onde parou?\n\nFaltam ${left} pessoa(s). Com limite de ${limit} por dia, leva ${fmtPlan(left, copy.batch || batch, copy.pauseSec || pauseSec, limit, addedToday)}.${phone ? `\nQuem adiciona: +${phone}.` : ''}`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy/resume', { to: copy.toId, dailyLimit: limit, session }); applyCopies(r.data); setJobLimit(copy.toId, null); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível continuar a importação.'); }
    finally { setBusy(false); }
  }

  /** Tira da lista uma importação que já terminou ou foi parada. */
  async function dismissCopy(copy: Copy) {
    const left = leftOf(copy);
    if (!confirm(`Tirar da lista a importação para "${copy.toName}"?${left > 0 ? `\n\nAinda faltavam ${left} pessoa(s) — elas não vão mais ser adicionadas.` : ''}`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.delete(`/api/whatsapp/groups/copy/${encodeURIComponent(copy.toId)}`); applyCopies(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível tirar a importação da lista.'); }
    finally { setBusy(false); }
  }

  async function sendInvites(copy: Copy) {
    if (!inviteText.includes('{link}')) return setMsg('A mensagem precisa ter {link} no lugar do link do grupo.');
    if (!confirm(`Mandar o convite de "${copy.toName}" no privado para ${copy.privacy.length} pessoa(s)?\n\nVai uma mensagem de cada vez, com uns 30 segundos entre elas, para proteger o número.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy/invite', { to: copy.toId, text: inviteText }); applyCopies(r.data); }
    catch (e: any) { setMsg(e?.response?.data?.error || e?.response?.data?.issues?.[0]?.message || 'Não foi possível mandar os convites.'); }
    finally { setBusy(false); }
  }

  async function downloadLeftOut(copy: Copy) {
    // Tenta pôr o link na planilha para facilitar mandar à mão; se não der, baixa sem ele.
    let link = '';
    try { link = await inviteLink(copy.toId, copy.session); } catch {}
    downloadCsv(`nao adicionados - ${safeName(copy.toName)}.csv`, [
      ['Telefone', 'Motivo', 'Link do grupo'],
      ...copy.privacy.map(p => [`+${p}`, 'privacidade (mandar convite)', link]),
      ...copy.failed.map(p => [`+${p}`, copy.failReasons?.[p] || 'erro', link]),
    ]);
  }

  async function extract() {
    if (!from) return setMsg('Escolha o grupo de origem.');
    setBusy(true); setMsg('');
    try {
      // Lê pelo número que está na origem (na tela do número descartável é sempre ele).
      const reader = candidatesFor(from)[0]?.id;
      const r = await api.get(`/api/whatsapp/groups/${encodeURIComponent(from)}/members${reader ? `?session=${reader}` : ''}`);
      const members: { jid: string; phone: string | null; admin: boolean }[] = r.data.members;
      downloadCsv(`contatos - ${safeName(r.data.name)}.csv`, [['Telefone', 'Administrador'], ...members.map(m => [m.phone ? `+${m.phone}` : '(número oculto)', m.admin ? 'sim' : 'não'])]);
      const hidden = members.filter(m => !m.phone).length;
      setMsg(`Pronto! ${members.length} contato(s) baixados${hidden ? ` (${hidden} com número oculto pelo WhatsApp)` : ''}.`);
    } catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível extrair os contatos.'); }
    finally { setBusy(false); }
  }

  /** Já existe uma importação parada pela metade para este destino? A nova substitui ela (e pula quem ela já adicionou). */
  function okToReplace() {
    const old = copies.find(c => c.toId === to);
    const left = old ? leftOf(old) : 0;
    return !old || left <= 0 || confirm(`O grupo "${old.toName}" já tem uma importação parada (${old.fromName}) com ${left} pessoa(s) faltando.\n\nSe começar uma nova para este grupo, aquela sai da lista (quem ela já adicionou continua sendo pulado). Quer seguir?\n\nPara só retomar a antiga, cancele e use "Continuar de onde parou" no quadro dela.`);
  }

  async function importTo() {
    if (!from || !to) return setMsg('Escolha o grupo de origem e o de destino.');
    if (autoInvite && !inviteText.includes('{link}')) return setMsg('A mensagem do convite precisa ter {link} no lugar do link do grupo.');
    if (from === to) return setMsg('Escolha grupos diferentes.');
    if (!okToReplace()) return;
    const src = groups.find(g => g.id === from), d = groups.find(g => g.id === to)?.name;
    const size = Math.min(20, Math.max(1, Math.round(batch) || 5));
    const limit = Math.min(1000, Math.max(1, Math.round(dailyLimit) || 50));
    if (multi && !via) return setMsg('Nenhum número conectado está nesse grupo de destino. Entre no grupo com um dos números e clique em Atualizar.');
    if (!confirm(`Adicionar os membros de "${src?.name}" no grupo "${d}"?${viaPhone ? ` Quem adiciona: +${viaPhone}.` : ''}\n\nVocê precisa ser administrador de "${d}". Vão entrar ${size} pessoa(s) a cada ${fmtPause(pauseSec)} — com ${src?.participants || 0} membros, leva ${fmtPlan(src?.participants || 0, size, pauseSec, limit, addedToday)}.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy', { from, to, batch: size, pauseSec, dailyLimit: limit, inviteText: autoInvite ? inviteText : undefined, session: via || undefined, tempContacts }); applyCopies(r.data); setJobLimit(to, null); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível iniciar a importação.'); }
    finally { setBusy(false); }
  }

  async function importFile() {
    if (!file) return setMsg('Escolha o arquivo com os telefones.');
    if (!to) return setMsg('Escolha o grupo de destino.');
    if (autoInvite && !inviteText.includes('{link}')) return setMsg('A mensagem do convite precisa ter {link} no lugar do link do grupo.');
    const { phones, skipped } = parsePhones(await file.text());
    if (!phones.length) return setMsg('Não achei nenhum telefone no arquivo. Coloque um número por linha, com DDD (ex.: 11 91234-5678).');
    if (!okToReplace()) return;
    const d = groups.find(g => g.id === to)?.name;
    const size = Math.min(20, Math.max(1, Math.round(batch) || 5));
    const limit = Math.min(1000, Math.max(1, Math.round(dailyLimit) || 50));
    if (multi && !via) return setMsg('Nenhum número conectado está nesse grupo de destino. Entre no grupo com um dos números e clique em Atualizar.');
    if (!confirm(`Adicionar ${phones.length} telefone(s) do arquivo "${file.name}" no grupo "${d}"?${skipped ? `\n(${skipped} linha(s) sem telefone válido foram ignoradas.)` : ''}${viaPhone ? `\nQuem adiciona: +${viaPhone}.` : ''}\n\nVocê precisa ser administrador de "${d}". Vão entrar ${size} pessoa(s) a cada ${fmtPause(pauseSec)} — leva ${fmtPlan(phones.length, size, pauseSec, limit, addedToday)}.`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/api/whatsapp/groups/copy', { phones, fileName: file.name, to, batch: size, pauseSec, dailyLimit: limit, inviteText: autoInvite ? inviteText : undefined, session: via || undefined, tempContacts }); applyCopies(r.data); setJobLimit(to, null); }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Não foi possível iniciar a importação.'); }
    finally { setBusy(false); }
  }

  const viaPhone = sessions.find(s => s.id === via)?.phone;
  // Só o grupo de destino escolhido é que não pode ter duas importações rodando juntas.
  const destBusy = copies.some(c => c.toId === to && (c.running || c.invite?.running));

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
        <button className="primary" disabled={busy || !from || !to || destBusy} onClick={importTo}><UserPlus size={16} /> Importar para o destino</button>
      </div>
      <div className="form-row form-row-tight">
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button className="primary" disabled={busy || !file || !to || destBusy} onClick={importFile}><FileUp size={16} /> Importar arquivo para o destino</button>
      </div>
      {destBusy && <p className="hint">Esse grupo de destino já tem uma importação rodando (veja o quadro dela aqui embaixo). Para importar ao mesmo tempo, escolha outro grupo.</p>}
      <p className="hint">O arquivo pode ser a planilha baixada em "Extrair contatos" ou um CSV/TXT com um telefone por linha, com DDD. Sem o 55 na frente, entende como número do Brasil.</p>
      {multi && (
        <div className="form-row form-row-tight">
          <label>Adicionar usando o número
            <select value={via} onChange={e => setVia(e.target.value)} disabled={!to}>
              {!to && <option value="">Escolha o grupo de destino primeiro</option>}
              {to && !candidates.length && <option value="">Nenhum número conectado está nesse grupo</option>}
              {candidates.map(s => <option key={s.id} value={s.id}>{phoneLabel(to, s)}</option>)}
            </select>
          </label>
        </div>
      )}
      {multi && <p className="hint">Só aparecem os números conectados que estão no grupo de destino; o que adiciona precisa ser administrador. Se esse número cair no meio, a importação espera ele voltar — não troca de número sozinha.</p>}
      <label className="check-line">
        <input type="checkbox" checked={tempContacts} onChange={e => setTempContacts(e.target.checked)} />
        Salvar cada número na agenda temporariamente antes de adicionar (sai da agenda logo depois)
      </label>
      <p className="hint">Quem bloqueou ser adicionado por desconhecidos costuma aceitar quando o número que adiciona o tem na agenda. O contato entra como "Oferta +55..." e é removido assim que o lote termina — mesmo quem você já tinha na lista passa por isso. Se algum número já estava na sua agenda, ele é tirado junto.</p>
      <div className="form-row form-row-tight">
        <label>Até quantas pessoas por vez
          <input type="number" min={1} max={20} value={batch} onChange={e => setBatch(Number(e.target.value))} />
        </label>
        <label>Esperar entre cada vez
          <select value={pauseSec} onChange={e => setPauseSec(Number(e.target.value))}>
            {PAUSES.map(s => <option key={s} value={s}>{fmtPause(s)}</option>)}
          </select>
        </label>
        <label>Limite por dia
          <input type="number" min={1} max={1000} value={dailyLimit} onChange={e => setDailyLimit(Number(e.target.value))} />
        </label>
        <button className="outline" disabled={busy || !to} onClick={copyLink}><Link2 size={16} /> Copiar link do grupo</button>
      </div>
      <p className="hint">Hoje já foram adicionadas {addedToday} pessoa(s) (somando todos os números). O limite por dia vale para cada número separado: soma as importações do dia feitas por aquele número. Quando o limite do dia acaba, a importação espera a meia-noite e continua sozinha — o sistema precisa ficar ligado.</p>
      <p className="hint">Dá para importar para vários grupos ao mesmo tempo: cada grupo de destino tem o seu quadro aqui embaixo, e uma não apaga a outra. Se o WhatsApp cair ou o sistema reiniciar, a importação espera e continua de onde parou — mas só adiciona alguém 5 minutos depois de reconectar (1 hora depois de escanear um QR code novo). Se o WhatsApp remover o aparelho no meio, ela pausa e só volta quando você mandar.</p>
      <p className="hint">Para o WhatsApp não estranhar, a ordem é embaralhada e cada vez entra um número diferente de pessoas (até o que você escolheu), com esperas que variam um pouco. Quem o sistema já adicionou no grupo antes é pulado, mesmo que tenha saído.</p>
      <p className="hint">Só funciona se você for administrador do grupo de destino. Quem bloqueou ser adicionado por desconhecidos (privacidade) não entra direto — dá para mandar o link de convite no privado deles.</p>
      <label className="check-line">
        <input type="checkbox" checked={autoInvite} onChange={e => setAutoInvite(e.target.checked)} />
        Mandar o convite no privado automaticamente para quem a privacidade bloquear
      </label>
      {autoInvite && (
        <>
          <label style={{ display: 'block', marginTop: 8 }}>Mensagem do convite (use {'{grupo}'} e {'{link}'})
            <textarea rows={5} value={inviteText} onChange={e => setInviteText(e.target.value)} />
          </label>
          <p className="hint">Sai quando a importação terminar, uma mensagem por vez com uns 30 segundos entre elas. Se você parar a importação, os convites não saem sozinhos (dá para mandar pelo botão depois).</p>
        </>
      )}

      {copies.map(copy => {
        const pct = copy.total ? Math.round((copy.done / copy.total) * 100) : 100;
        const left = leftOf(copy);
        const jobLimit = jobLimits[copy.toId];
        return (
          <div className="inline-msg" key={copy.toId}>
            <b>{copy.running ? 'Importando' : 'Importação'}: {copy.fromName} → {copy.toName}{copy.sessionPhone ? ` (pelo número +${copy.sessionPhone})` : ''}</b>
            {copy.running && <div>{copy.done} de {copy.total} ({pct}%)…{copy.batch && copy.pauseSec ? ` ${copy.batch} pessoa(s) a cada ${fmtPause(copy.pauseSec)}, faltam ${fmtPlan(copy.total - copy.done, copy.batch, copy.pauseSec, copy.dailyLimit || 1000, addedToday)}.` : ''}</div>}
            {copy.running && copy.waitingConnection && <div>⏸️ O WhatsApp está desconectado. A importação espera ele voltar e continua sozinha de onde parou.</div>}
            {copy.running && copy.warmingUntil && <div>⏸️ O WhatsApp conectou agora há pouco. Para ele não desconfiar, a importação espera a conexão firmar e volta sozinha às {new Date(copy.warmingUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.</div>}
            {copy.running && copy.waitingUntil && <div>⏸️ Limite de {copy.dailyLimit} por dia atingido. Continua sozinha {new Date(copy.waitingUntil).toLocaleString('pt-BR', { weekday: 'long', hour: '2-digit', minute: '2-digit' })} — ou aumente o limite aqui embaixo para continuar agora.</div>}
            {copy.running && (copy.stopped
              ? <div>Parando… o lote que já estava saindo termina e mais ninguém é adicionado.</div>
              : <button className="outline" style={{ marginTop: 8 }} disabled={busy} onClick={() => stopCopy(copy)}><Square size={16} /> Parar importação</button>)}
            {!copy.running && copy.stopped && <div>Importação parada por você.</div>}
            {copy.running && !copy.stopped && (
              <div className="form-row form-row-tight" style={{ marginTop: 8 }}>
                <label>Limite por dia desta importação
                  <input type="number" min={1} max={1000} value={jobLimit ?? copy.dailyLimit ?? ''} onChange={e => setJobLimit(copy.toId, Number(e.target.value))} />
                </label>
                <button className="outline" disabled={busy || jobLimit == null || jobLimit === copy.dailyLimit} onClick={() => changeLimit(copy)}>Mudar limite</button>
              </div>
            )}
            {!copy.running && !copy.invite?.running && left > 0 && (
              <div style={{ marginTop: 8 }}>
                <div>Faltam {left} pessoa(s) para adicionar. Hoje já entraram {addedToday}; escolha o limite por dia e continue de onde parou.</div>
                <div className="form-row form-row-tight">
                  <label>Limite por dia
                    <input type="number" min={1} max={1000} value={jobLimit ?? copy.dailyLimit ?? dailyLimit} onChange={e => setJobLimit(copy.toId, Number(e.target.value))} />
                  </label>
                  {multi && (
                    <label>Adicionar usando o número
                      <select value={viaFor(copy)} onChange={e => setJobVias(m => ({ ...m, [copy.toId]: e.target.value }))}>
                        {!candidatesFor(copy.toId).length && <option value="">Nenhum número conectado está nesse grupo</option>}
                        {candidatesFor(copy.toId).map(s => <option key={s.id} value={s.id}>{phoneLabel(copy.toId, s)}</option>)}
                      </select>
                    </label>
                  )}
                  <button className="primary" disabled={busy} onClick={() => resumeCopy(copy)}><Play size={16} /> Continuar de onde parou</button>
                </div>
              </div>
            )}
            <div>{copy.added} adicionado(s) · {copy.already} já estavam no grupo{copy.skippedBefore ? ` · ${copy.skippedBefore} pulados (o sistema já tinha adicionado antes)` : ''}{copy.privacy.length ? ` · ${copy.privacy.length} bloqueados pela privacidade` : ''}{copy.failed.length ? ` · ${copy.failed.length} com erro` : ''}{copy.noPhone ? ` · ${copy.noPhone} com número oculto` : ''}</div>
            {copy.failed.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {copy.failed.slice(0, 20).map(p => <li key={p}>+{p}: {copy.failReasons?.[p] || 'erro (motivo não registrado)'}</li>)}
                {copy.failed.length > 20 && <li>e mais {copy.failed.length - 20} — veja todos em "Baixar os que não entraram".</li>}
              </ul>
            )}
            {copy.error && <div>Ops, a importação parou: {copy.error}</div>}
            {!copy.running && (copy.privacy.length + copy.failed.length) > 0 && (
              <button className="outline" style={{ marginTop: 8, marginRight: 8 }} onClick={() => downloadLeftOut(copy)}>
                <Download size={16} /> Baixar os que não entraram
              </button>
            )}
            {!copy.running && !copy.invite?.running && (
              <button className="outline" style={{ marginTop: 8 }} disabled={busy} onClick={() => dismissCopy(copy)}><X size={16} /> Tirar da lista</button>
            )}
            {copy.invite && (
              <div style={{ marginTop: 8 }}>
                <b>Convites no privado:</b> {copy.invite.sent} de {copy.invite.total} enviado(s){copy.invite.failed.length ? ` · ${copy.invite.failed.length} com erro` : ''}{copy.invite.running ? '…' : '.'}
                {copy.invite.error && <div>Ops, o envio parou: {copy.invite.error}</div>}
              </div>
            )}
            {!copy.running && copy.privacy.length > 0 && !copy.invite?.running && (!copy.autoInvite || copy.invite || copy.stopped) && (
              <div style={{ marginTop: 10 }}>
                <label>Mensagem do convite (use {'{grupo}'} e {'{link}'})
                  <textarea rows={5} value={inviteText} onChange={e => setInviteText(e.target.value)} />
                </label>
                <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={() => sendInvites(copy)}>
                  <Send size={16} /> {copy.invite ? 'Mandar convite de novo' : 'Mandar convite no privado'} ({copy.privacy.length})
                </button>
              </div>
            )}
          </div>
        );
      })}
      {msg && <p className="inline-msg">{msg}</p>}
    </div>
  );
}
