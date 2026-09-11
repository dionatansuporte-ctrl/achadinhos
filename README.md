# OfertasDaHora — projeto completo

Projeto full-stack para automatizar achadinhos/ofertas de afiliados, inspirado no layout enviado: dashboard, listas, produtos, automações em 6 etapas, canais, histórico e configurações.

## O que já está no código

- Login e cadastro com senha criptografada (bcrypt) e sessão JWT.
- PostgreSQL + Prisma.
- Redis + BullMQ para fila de envios.
- Mercado Livre OAuth 2.0 com `state`, PKCE, refresh token e criptografia AES-256-GCM em repouso.
- Importação de produto do Mercado Livre por URL/ID MLB usando API oficial.
- Cadastro manual de produtos Shopee com link de afiliado.
- Motor de regras: desconto mínimo, preço máximo, marketplace e palavras-chave.
- Variáveis de conteúdo: `{{title}}`, `{{price}}`, `{{oldPrice}}`, `{{discount}}`, `{{coupon}}`, `{{affiliateUrl}}`.
- Geração de jobs para todos os produtos elegíveis e canais ativos.
- Worker com retry e histórico de execução.
- WhatsApp Cloud API oficial para envio por contato.
- Instagram Graph API preparada para publicação de imagem.
- Cadastro de canais, automações, listas e logs.
- Interface responsiva em português, com tema escuro/laranja semelhante ao mockup.
- Shopee Affiliate Open API preparada por configuração, sem scraping.

## Limitação importante sobre WhatsApp

O projeto usa a API oficial do WhatsApp Business/Cloud API. Ela não deve ser usada para automatizar WhatsApp Web ou para enviar mensagens arbitrárias a grupos. A tela “Canais” trabalha com destinos suportados pela API oficial. Se for necessário publicar em grupos, deve ser escolhida uma solução oficial/provedor que ofereça essa capacidade e validada antes da implementação.

## Estrutura

```text
achadinhopro-final/
├── apps/
│   ├── api/
│   │   ├── prisma/schema.prisma
│   │   └── src/
│   │       ├── integrations/
│   │       ├── middleware/
│   │       ├── services/
│   │       ├── server.ts
│   │       └── worker.ts
│   └── web/
│       └── src/App.tsx
├── docker-compose.yml
└── README.md
```

## 1. Requisitos

- Node.js 20+
- Docker Desktop
- Conta PostgreSQL/Redis local via Docker
- Credenciais próprias das APIs que serão usadas

## 2. Subir banco e Redis

```bash
docker compose up -d
```

## 3. API

```bash
cd apps/api
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Em outro terminal:

```bash
cd apps/api
npm run worker
```

API: `http://localhost:3333`

## 4. Frontend

```bash
cd apps/web
npm install
npm run dev
```

Frontend: `http://127.0.0.1:8080`

Se a API estiver em outro endereço, crie `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3333
```

## 5. Chave de criptografia

Gere uma chave base64 de 32 bytes. Exemplo com Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Cole o resultado em `TOKEN_ENCRYPTION_KEY`.

## 6. Mercado Livre

No DevCenter do Mercado Livre, crie uma aplicação e configure exatamente o Redirect URI usado no `.env`:

```env
ML_CLIENT_ID=SEU_APP_ID
ML_CLIENT_SECRET=SUA_SECRET_KEY
ML_REDIRECT_URI=http://localhost:3333/api/integrations/mercadolivre/callback
```

Depois de entrar no sistema, abra Configurações > Mercado Livre > Conectar.

O fluxo implementado é server-side OAuth 2.0, com state + PKCE, troca do code por access token e refresh token. Os tokens são criptografados antes de serem gravados.

## 7. Shopee

Preencha as credenciais da Open API oficial quando sua aplicação estiver habilitada:

```env
SHOPEE_APP_ID=
SHOPEE_SECRET=
```

O código não faz scraping da Shopee e não inventa endpoints de afiliado. A assinatura/requisição deve seguir exatamente o contrato exibido no Explorer oficial da Shopee para a conta/app do projeto.

## 7b. Cupons (Shopee e Mercado Livre)

Nenhuma das duas plataformas entrega cupom pela API de afiliado. A tela **Cupons** resolve assim:

- Cadastre o cupom (código, descrição, compra mínima, validade) ou cole a lista de um grupo do Telegram/WhatsApp: o sistema reconhece `🎟️ CODIGO - 10% OFF` (regra na linha de baixo) e `descrição: CODIGO`.
- Informe um **canal público do Telegram** (ex.: `melicupons`) e o robô importa a última mensagem com cupons antes de cada envio, via `https://t.me/s/<canal>` (sem login).
- O **listão** de cada marketplace sai para os grupos escolhidos no intervalo configurado (padrão 2 h, janela 08:00–22:00), só com cupons não vencidos, e com o **seu** link no fim (carteira de cupons Shopee ou link de afiliado do ML). O link que vem nas listas de terceiros é ignorado.
- Opcional por cupom: entrar também na linha "🎟️ Cupom" das mensagens de produto do mesmo marketplace quando o preço atinge a compra mínima.

## 8. WhatsApp Cloud API

Configure no backend:

```env
META_ACCESS_TOKEN=
META_PHONE_NUMBER_ID=
META_WABA_ID=
META_API_VERSION=v23.0
```

Cadastre um canal com telefone em formato internacional. O worker usa a API oficial para enviar texto.

## 9. Instagram

Configure:

```env
META_ACCESS_TOKEN=
META_IG_USER_ID=
META_API_VERSION=v23.0
```

Para publicação de imagem, o `imageUrl` precisa ser público e acessível pela API da Meta.

## 10. Fluxo completo

1. Criar conta.
2. Conectar Mercado Livre.
3. Configurar Shopee/Meta no `.env`.
4. Criar canal WhatsApp e/ou Instagram.
5. Criar lista.
6. Importar produtos.
7. Criar automação.
8. Definir desconto/preço/marketplace.
9. Ativar automação.
10. Clicar em “Gerar envios” ou conectar um scheduler para geração periódica.
11. BullMQ coloca os jobs na fila.
12. Worker envia e grava o resultado em Histórico.

## Produção

Antes de colocar na internet, faça obrigatoriamente:

- HTTPS.
- Segredos somente no backend/secret manager.
- Rotação de JWT e chaves.
- Rate limiting.
- CSRF/CORS restrito ao domínio final.
- Backup PostgreSQL.
- Observabilidade.
- Validação de permissões de cada API.
- Termos/políticas das plataformas.
- Scheduler dedicado para gerar jobs automaticamente.
- Webhooks oficiais quando necessários.

## Fontes oficiais usadas como referência

Mercado Livre: documentação de autenticação/autorização e criação/gestão de aplicações.

Shopee: Affiliate Open API Explorer.

Meta: use a documentação oficial da versão da API habilitada para sua aplicação para confirmar permissões, versões e requisitos antes de produção.
