# WhatsApp Baileys Backend — v2.0 (Redis + Multi-tenant)

Backend Node.js multiusuário para WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys), com **persistência em Redis**, isolamento real por `userId` e webhook assinado com HMAC.

## Por que v2

A v1 salvava sessões em arquivos locais (`auth_info/`). Em hospedagem efêmera (Railway, Render, Fly.io), isso causa **perda de sessão a cada redeploy** — clientes precisam escanear QR de novo. A v2 corrige isso:

- ✅ Credenciais Baileys armazenadas em **Redis** (sobrevive a restarts)
- ✅ Multi-tenant real: `userId` validado, sessões isoladas por namespace
- ✅ Webhook **assinado com HMAC-SHA256** + idempotency key
- ✅ **Dead-letter queue** em Redis para webhooks que falham todos os retries
- ✅ Reconexão com **backoff exponencial + jitter**
- ✅ **Debounce** de mensagens em rajada por contato
- ✅ Healthcheck com status do Redis e contagem de sessões

## Endpoints

Todos exigem header `x-api-key: <API_KEY>`, exceto `/health`.

| Método | Rota                      | Body / Params                            | Descrição                                |
|--------|---------------------------|------------------------------------------|------------------------------------------|
| GET    | `/health`                 | —                                        | Status do servidor + Redis + sessões     |
| POST   | `/session/start`          | `{ userId }`                             | Cria/inicia sessão, retorna QR se novo   |
| GET    | `/session/status/:userId` | —                                        | Estado atual + QR (se aguardando)        |
| GET    | `/session/list`           | —                                        | Lista todas as sessões em memória        |
| POST   | `/session/send`           | `{ userId, number, message }`            | Envia mensagem                           |
| POST   | `/session/stop`           | `{ userId }`                             | Encerra sessão e limpa credenciais       |

`userId` deve casar com `^[a-zA-Z0-9_-]{3,64}$`.

## Estados de sessão

- `not_started` — nunca foi iniciada
- `connecting` — iniciando socket
- `waiting_qr` — QR gerado, aguardando scan
- `connected` — pronta pra enviar/receber
- `reconnecting` — caiu, tentando reconectar (backoff exponencial)
- `disconnected` — desconectada (esgotou tentativas ou foi substituída)
- `logged_out` — deslogada do lado do WhatsApp; precisa novo `/session/start`

## Webhook (mensagens recebidas)

O backend faz `POST` no `LOVABLE_WEBHOOK_URL` com:

```json
{
  "userId": "cliente_123",
  "messageId": "3EB0xxx",
  "from": "5511999998888",
  "fromName": "Fulano",
  "message": "oi tudo bem",
  "messageType": "text",
  "timestamp": 1729450000000,
  "isReply": false,
  "quotedMessageId": null,
  "groupedCount": 1
}
```

Headers:
- `x-api-key`: o mesmo `API_KEY`
- `x-webhook-signature`: HMAC-SHA256(body, WEBHOOK_SECRET) em hex
- `x-idempotency-key`: igual ao `messageId` (use pra deduplicar)

**Resposta esperada do Lovable:** JSON `{ "response": "texto a enviar" }`. Se vier vazio ou não-string, nada é enviado.

### Validar a assinatura no Lovable (exemplo)

```js
import crypto from 'crypto'

const body = await request.text()
const signature = request.headers.get('x-webhook-signature')
const expected = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(body)
  .digest('hex')

if (signature !== expected) return new Response('Unauthorized', { status: 401 })
const payload = JSON.parse(body)
```

## Variáveis de ambiente

Veja `.env.example`. Essenciais:

```
API_KEY=<openssl rand -hex 32>
WEBHOOK_SECRET=<openssl rand -hex 32>
LOVABLE_WEBHOOK_URL=https://seu-projeto.lovable.app/api/whatsapp/webhook
REDIS_URL=redis://...
```

---

## 🚀 Deploy no Railway (recomendado)

1. **Crie o projeto no Railway:** https://railway.app/new
2. **Adicione o plugin Redis:** dentro do projeto, `+ New` → `Database` → `Add Redis`. A `REDIS_URL` é injetada automaticamente.
3. **Suba o código no GitHub** (essa pasta `backend-baileys/`) e conecte: `+ New` → `GitHub Repo`.
4. **Configure as variáveis** em `Variables`:
   - `API_KEY` (gere com `openssl rand -hex 32`)
   - `WEBHOOK_SECRET` (gere com `openssl rand -hex 32`)
   - `LOVABLE_WEBHOOK_URL` (depois que tiver o webhook no painel Lovable)
   - As demais são opcionais — defaults estão no `.env.example`.
5. **Healthcheck:** Railway lê `railway.json` e usa `/health`.
6. Deploy automático a cada push.

> ⚠️ **Não use o disco do Railway pra Baileys.** É efêmero — perde tudo no redeploy. Por isso a v2 obriga Redis.

### Alternativa: Upstash Redis (free tier)

Se preferir Redis gerenciado externo:
1. Crie em https://upstash.com (free tier 10k commands/dia)
2. Copie a `REDIS_URL` (formato `rediss://default:senha@xxx.upstash.io:6379`)
3. Cole em `REDIS_URL` no Railway (em vez do plugin)

---

## 💻 Rodando localmente

### Opção A — Docker Compose (mais fácil)

```bash
cd backend-baileys
cp .env.example .env
# edite .env e preencha API_KEY, WEBHOOK_SECRET, LOVABLE_WEBHOOK_URL
docker compose up --build
```

### Opção B — Node + Redis local

```bash
# 1. Suba um Redis local
docker run -d -p 6379:6379 redis:7-alpine

# 2. Configure
cd backend-baileys
cp .env.example .env
# edite .env (REDIS_URL=redis://localhost:6379)

# 3. Instale e rode
npm install
npm start
```

Servidor sobe em `http://localhost:3000`.

---

## 🧪 Testando os endpoints

```bash
API=http://localhost:3000
KEY=sua-api-key

# Healthcheck
curl $API/health

# Iniciar sessão (retorna QR como data URL)
curl -X POST $API/session/start \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"cliente_001"}'

# Ver QR
curl $API/session/status/cliente_001 -H "x-api-key: $KEY"

# Listar sessões
curl $API/session/list -H "x-api-key: $KEY"

# Enviar mensagem
curl -X POST $API/session/send \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"cliente_001","number":"5511999998888","message":"oi do bot"}'

# Encerrar
curl -X POST $API/session/stop \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"cliente_001"}'
```

### Visualizar QR no navegador

O retorno traz `qr` como `data:image/png;base64,...`. Cole no navegador ou num HTML:

```html
<img src="COLE_O_DATA_URL_AQUI" />
```

---

## Arquitetura

```
┌─────────────┐         ┌────────────────────┐
│  WhatsApp   │ ◀────▶ │  Baileys Socket    │
└─────────────┘         │  (por userId)      │
                        └────────┬───────────┘
                                 │
                        ┌────────▼───────────┐
                        │  sessionManager    │
                        └────┬──────────┬────┘
                             │          │
            ┌────────────────▼──┐   ┌───▼───────────────┐
            │  Redis            │   │  Webhook          │
            │  - creds/keys     │   │  (HMAC + retry +  │
            │  - active set     │   │   DLQ)            │
            │  - DLQ            │   └───────┬───────────┘
            └───────────────────┘           │
                                            ▼
                                   ┌─────────────────┐
                                   │  Lovable        │
                                   └─────────────────┘
```

## Estrutura

```
backend-baileys/
├── Dockerfile
├── docker-compose.yml
├── railway.json
├── .env.example
├── package.json
└── src/
    ├── server.js              # Express + healthcheck
    ├── config.js              # env vars centralizadas
    ├── middleware/
    │   ├── auth.js
    │   └── validateUserId.js
    ├── routes/
    │   └── session.js
    ├── services/
    │   ├── sessionManager.js  # mapa em memória + Redis
    │   ├── whatsappClient.js  # Baileys + reconexão + debounce
    │   └── redisAuthState.js  # substitui useMultiFileAuthState
    └── utils/
        ├── logger.js          # pino JSON
        ├── redis.js           # ioredis singleton
        └── webhook.js         # HMAC + retry + DLQ
```

## Troubleshooting

- **`Variável de ambiente obrigatória ausente: REDIS_URL`** — defina no `.env` ou nas variáveis do Railway.
- **`Redis erro: connect ECONNREFUSED`** — Redis não está rodando. Local: `docker run -d -p 6379:6379 redis:7-alpine`.
- **QR não aparece** — chame `POST /session/start`, depois polling em `GET /session/status/:userId`.
- **Sessão fica em `reconnecting`** — veja logs; se `lastError=loggedOut`, escaneie QR de novo.
- **Assinatura não bate** — confira `WEBHOOK_SECRET` igual nos dois lados.

## Próxima fase

Esta versão entrega infra estável. Próxima fase (painel Lovable): auth, QR UI, memória de conversa, RAG.

## Licença

MIT
