import fs from 'node:fs';
import path from 'node:path';

/**
 * Arquivos de estado em .cache (quem já foi adicionado, limite do dia, importações, fila de convites...).
 *
 * Antes eram regravados direto por cima: se a energia caísse no meio da escrita, o arquivo ficava pela metade,
 * a leitura falhava e o sistema entendia "vazio" — voltava a adicionar quem já tinha saído do grupo e zerava o
 * limite do dia, que é o que faz o WhatsApp bloquear o número. Agora:
 *  - grava num .tmp e só depois troca pelo arquivo de verdade (a troca é instantânea: ou fica o velho, ou o novo);
 *  - guarda a versão anterior em .bak, e a leitura usa o .bak se o arquivo principal estiver estragado.
 */
export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`); } catch { /* sem cópia de segurança desta vez */ }
  // No Windows a troca pode falhar por um instante se o antivírus estiver lendo o arquivo: tenta de novo.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e: any) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        // Último recurso: grava direto (como era antes) para não perder o dado novo.
        fs.writeFileSync(file, JSON.stringify(data));
        try { fs.rmSync(tmp, { force: true }); } catch { /* fica para a próxima */ }
        return;
      }
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) { /* espera curta sem travar com timers */ }
    }
  }
}

/** Lê o arquivo; se ele estiver estragado, tenta a versão anterior (.bak); se nada der, devolve `fallback`. */
export function readJson<T>(file: string, fallback: T): T {
  for (const f of [file, `${file}.bak`]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) ?? fallback; }
    catch (e: any) {
      if (e?.code === 'ENOENT') { if (f === file) continue; break; }
      console.warn(`[estado] ${path.basename(f)} está ilegível (${e?.message || e}).${f === file ? ' Tentando a cópia anterior.' : ''}`);
    }
  }
  return fallback;
}
