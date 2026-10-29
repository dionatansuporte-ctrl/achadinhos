/**
 * Link curto para as mensagens (pedido do usuário em 2026-10-28: o link do Mercado Livre, com matt_tool e
 * matt_word, ocupava três linhas no grupo). A Shopee já entrega link curto (s.shopee.com.br); os outros passam
 * pelo TinyURL e, se ele falhar, pelo is.gd — serviços gratuitos, sem chave. Qualquer falha devolve o link original:
 * o envio nunca fica preso por causa do encurtador.
 */
const SHORT_HOSTS = ['s.shopee.com.br', 'shope.ee', 'mercadolivre.com/sec', 'meli.la', 'amzn.to', 'tinyurl.com', 'is.gd'];
const cache = new Map<string, string>();

export function isShortLink(url: string) {
  return url.length <= 60 || SHORT_HOSTS.some(h => url.includes(h));
}

async function ask(api: string, timeoutMs = 6000): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(api, { signal: ctl.signal });
    const text = (await r.text()).trim();
    return r.ok && /^https?:\/\/\S+$/.test(text) ? text : null;
  } catch { return null; } finally { clearTimeout(t); }
}

export async function shortLink(url: string): Promise<string> {
  if (isShortLink(url)) return url;
  const hit = cache.get(url);
  if (hit) return hit;
  const enc = encodeURIComponent(url);
  const short = await ask(`https://tinyurl.com/api-create.php?url=${enc}`) || await ask(`https://is.gd/create.php?format=simple&url=${enc}`);
  if (!short) return url;
  cache.set(url, short);
  return short;
}
