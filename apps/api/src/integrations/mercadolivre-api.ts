export async function mercadoLivreGet<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Mercado Livre API HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
