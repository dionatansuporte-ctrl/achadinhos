/**
 * Telefones de um texto ou CSV/TXT: toda célula que pareça telefone, em qualquer linha.
 * Com 10 ou 11 dígitos (DDD + número) assume Brasil e põe o 55 na frente — inclusive DDD 55 (Santa Maria).
 * Linhas sem nenhum telefone válido contam em `skipped` (cabeçalho da planilha, por exemplo).
 */
export function parsePhones(text: string) {
  const phones = new Set<string>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let found = false;
    for (const cell of line.split(/[;,\t]/)) {
      const d = cell.replace(/\D/g, '');
      if (/^\d{10,11}$/.test(d)) { phones.add(`55${d}`); found = true; }
      else if (/^\d{12,15}$/.test(d)) { phones.add(d); found = true; }
    }
    if (!found) skipped++;
  }
  return { phones: [...phones], skipped };
}
