# Manuarte App — Backend

Backend API for Manuarte: inventory, sales, billing, and customer management, plus **Gema**, an AI-powered WhatsApp sales agent for Colombia and Ecuador.

## Stack

- **Runtime**: Node.js + Express + TypeScript (compiled to CommonJS in `dist/`)
- **Database**: PostgreSQL via Sequelize ORM (migrations via `sequelize-cli`), with `pgvector` for embeddings
- **Cache/Sessions**: Redis (ioredis) — used for WhatsApp agent session state
- **AI**: OpenAI API (chat completions + embeddings)
- **PDF generation**: `@react-pdf/renderer` for billing and quote documents

## Requirements

- Node.js (LTS) and npm
- PostgreSQL with the `pgvector` extension available
- Redis

## Local services

Postgres and Redis are **not** in this repo. They are machine-level development dependencies shared with other projects, so each one lives in its own compose project under `D:\workspace\infra\`:

| Service | Location | Host address |
|---|---|---|
| PostgreSQL + pgvector | `D:\workspace\infra\postgres-local\` | `localhost:5433` |
| Redis | `D:\workspace\infra\redis-local\` | `127.0.0.1:6379` |

```bash
cd D:\workspace\infra\redis-local
docker compose up -d        # start
docker compose ps           # status
docker compose logs -f
docker compose down         # stop, keeping data
```

Keeping them out of the repo leaves `backend/` free for an application compose file when the app itself is containerized, without the app's lifecycle dragging the databases with it.

Redis binds to `127.0.0.1:6379` only and runs without a password, matching a `.env` that leaves `REDIS_PASSWORD` unset. Persistence (AOF) is on, so restarting the container mid-test does not wipe pauses (24 h TTL) or sessions (2 h TTL).

To inspect that state, use the **RedisInsight desktop app** (`winget install RedisInsight.RedisInsight`) and add the database as **host `127.0.0.1`, port `6379`**, no password. It is deliberately not a compose service: an inspection tool does not need a permanently running container.

Keys worth watching while testing the agent:

| Key | Contents |
|---|---|
| `session:<phoneNumberId>:<phone>` | Conversation session, 2 h TTL |
| `wa:ai-pause:<phoneNumberId>:<phone>` | Human-intervention pause, 24 h TTL, holds `pausedAt` / `lastHumanAt` |
| `wa:seen:<wamid>` | Deduplication marker, 15 min TTL |
| `wa:self-send:<wamid>` | Agent's own sends, 1 h TTL |

The `phoneNumberId` prefix is the visual proof that per-line state never mixes.

## Getting started

```bash
# Install dependencies
npm install

# Configure environment
# Create .env (and .env.production / .env.test as needed) — see "Environment variables" below

# Start the local services (see "Local services")
cd D:\workspace\infra\postgres-local && docker compose up -d
cd D:\workspace\infra\redis-local && docker compose up -d

# Run database migrations
npm run migrate

# Seed initial data (optional)
npm run seed:all

# Start the dev server (hot reload via ts-node-dev)
npm run dev
```

The server logs `✅ Server listening on port <PORT>` once it connects to Postgres and Redis.

If it ever stops, it says why. `src/index.ts` registers process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGINT`/`SIGTERM`, `beforeExit` (the event loop ran out of work, so nothing is listening any more) and `exit` as a last resort, plus an `error` handler on the HTTP server for the asynchronous failures `app.listen` reports outside the `try` block, such as `EADDRINUSE`. The `dev` script runs `ts-node-dev --respawn`: without it, ts-node-dev exits with code 0 and prints nothing when the script exits cleanly, which looks exactly like pressing Ctrl+C.

## Scripts

```bash
npm run dev                                # Development server with hot reload
npm run build                              # Compile TypeScript to dist/
npm start                                  # Run the compiled build (dist/index.js)

npm run migrate                            # Run all pending migrations
npm run migrate:undo                       # Undo the last migration
npm run generate:migration -- <name>       # Scaffold a new migration
npm run generate:seeder -- <name>          # Scaffold a new seeder

npm run seed:all                           # Run all seeders
npm run seed -- <seeder-file>              # Run a specific seeder
npm run seed:undo                          # Undo the last seeder
npm run seed:undo:all                      # Undo all seeders

npm run rag:load                           # Load RAG documents (data/) into the pgvector-backed rag_docs table
```

There is no automated test suite (`npm test` intentionally fails).

## Environment variables

`src/config/env.ts` is the only place that reads `process.env`, and the only place defaults live. It loads `.env` first and then `.env.{NODE_ENV}` on top (`NODE_ENV` defaults to `development`). Sequelize CLI reads the same files via `config/config.js`.

Copy [`.env.example`](.env.example) to `.env` and fill in real values. It documents every variable, and both files follow the same section order so they can be read side by side. A variable left empty is treated as unset and falls back to the default in `env.ts`.

| Section | What it covers |
|---|---|
| Servidor | `PORT`, `FRONTEND_URL` (the CORS origin; previously `CLIENT_URL`) |
| PostgreSQL / Redis | Connection details for the two local services |
| Autenticacion / OpenAI | JWT secrets, `OPENAI_API_KEY` |
| WhatsApp Cloud API | `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_VERIFY_TOKEN`, shared by every number |
| Documentos PDF | `WHATSAPP_DOCS_PHONE_NUMBER_ID` — the dedicated number the panel sends quotes and invoices from. Not an agent line |
| Agente Gema: lineas | `WHATSAPP_LINE_{CO,EC}_*` — one line per operation |
| Agente Gema: comportamiento | `WHATSAPP_AI_PAUSE_TTL_SECONDS`, `AGENT_SYSTEM_USER_ID` (a user UUID of this app, not a WhatsApp id) |
| Notificaciones a la tienda | `SHOP_NOTIFY_{CO,EC}_PHONE` — receives copies of quote and invoice PDFs, and is permanently on the agent's denylist. In Colombia it currently equals the agent line's own number |
| Pagos | Bold, PayPhone, Nequi and `PAYMENT_QR_EC_INFO` (Ecuador payment details — provisionally transfer text, to become a QR like Colombia's). Both payment API URLs are fixed in `payment-link.service.ts` and are not configurable |
| Overrides de prueba | `TEST_PAYPHONE_IN_CO` |

## Architecture

### Module pattern

Every feature lives under `src/modules/{name}/` and follows the same layered structure:

```
src/modules/{name}/
├── routes.ts       # Express Router — wires Model → Service → Controller
├── controller.ts   # Thin class; handles req/res only, no business logic
├── service.ts      # Class with business logic; receives model(s) via constructor injection
├── model.ts        # Sequelize model + associations (declared at the bottom)
└── types.ts        # Module-specific types
```

Flow: **Route → Controller → Service → Model**. Controllers never touch Sequelize models directly; all associations across modules live in `src/modules/associations/`.

### Routing & auth

`src/routes.ts` mounts all routers under `/api/v1`. `/auth` and `/whatsapp-agent` are public; everything else sits behind `verifyJWT` (`src/middlewares/verifyJWT.ts`), which attaches the decoded user ID to `req.requestedBy`.

### WhatsApp Agent — "Gema" (`src/modules/whatsapp-agent/`)

An AI sales agent that handles customer conversations over WhatsApp. It runs on numbers with **Coexistence** enabled, so the staff keeps using WhatsApp Business App on the same line.

Webhook: `POST /api/v1/whatsapp-agent/webhook` (public). Verification handshake on `GET` with `hub.verify_token` matched against `WHATSAPP_VERIFY_TOKEN`.

- **Lines**: one line = one operation. The `phone_number_id` in the webhook decides country, shop, inventory and currency — *not* the customer's phone prefix, since a customer can write to any line. Configure each with `WHATSAPP_LINE_{CO,EC}_*`; an unset `PHONE_NUMBER_ID` leaves that line unregistered and its events ignored. Redis state is namespaced per line, so the same customer on two lines is two independent conversations.
- **AI / human coexistence**: an `smb_message_echoes` event means a person replied from the Business App or WhatsApp Web, and pauses the AI for that conversation (TTL `WHATSAPP_AI_PAUSE_TTL_SECONDS`, renewed on each staff message). The same pause applies when a customer asks to speak to a person: the agent answers and then steps aside, saying so plainly if the shop is closed. It is detected both by the NLU (`human_handoff`) and, while a quote or purchase flow is running, by an explicit-request check that runs before the flow interceptors. Pausing always drops any half-finished flow while keeping the conversation context. Reactivation is only the TTL lapsing, except for one testing affordance: with `WHATSAPP_AGENT_TEST_COMMANDS=true` (off by default) the staff can write `#gema-on` to hand the conversation back immediately (`#gema on` and `#gemaon` also work). The AI restarts the thread from scratch, keeping only who the customer is. Only recognised from the staff side, and visible to the customer, so it is meant for test rounds only. Messages received during a pause are logged but never processed retroactively. Every agent send registers its `wamid` so the agent can't mistake its own echo for human intervention.
- **Test allowlist**: `WHATSAPP_LINE_*_AI_ALLOWLIST` (+ `_ENABLED`, default `true`) limits automatic replies to listed numbers while the agent is being rolled out. Every registered line's own number and the shop numbers are always on a denylist, on every line: one line writing to another is staff, not a customer. A line's number does not have to belong to its country — Ecuador currently runs on a Colombian number for testing, and the operation still comes from `phone_number_id`.
- **Message buffering**: incoming messages are held per phone number for `BUFFER_WAIT_MS` (defined in `constants.ts`) to merge rapid multi-part messages into a single turn. A staff reply discards the pending buffer.
- **Session state**: each `UserSession` (cart, active flow, last product list, country, flags) is serialized to Redis with a 2-hour TTL, under `session:<phoneNumberId>:<phone>`. All session I/O goes through `session.store.ts`.
- **Sub-services**: `WhatsAppAgentService` (entry point/queue), `OpenAIService` (chat + embeddings, owns the Gema system prompt), `FlowsService` (quote & checkout flows), `IntentHandlerService` (intent dispatch), `CountryService` (line → operating context), `AiStateService` (pause, dedup, self-send registry), `ProductSearchService`, `MediaHandlerService`, `PaymentLinkService`, `WhatsAppLogService`.
- **Intent detection**: a single OpenAI call is the only classifier; the old regex rule engine was removed (`helpers/intent-detection.ts` now holds only `stripCallingCode` and `isFarewellOnly`).

#### Meta setup

The app must be subscribed, for each agent line, to **`messages`** and **`smb_message_echoes`**. `history` and `smb_app_state_sync` are deliberately not used. Staff should reply from the phone app or WhatsApp Web (both verified to emit echoes); per Meta's docs, WhatsApp for Windows and WearOS do not emit webhooks, so intervention from those clients would be invisible to the agent.

#### Replaying webhooks locally

There is no automated test suite. `npm run wa:replay -- <fixture>` POSTs a real-shaped payload at the local webhook; `npm run wa:replay -- --list` shows the fixtures and `scripts/wa-fixtures/README.md` documents what each one should prove. The payloads carry placeholders instead of a hardcoded line, resolved from `.env` when sent, so they do not go stale when the line changes. `--line CO|EC` chooses the line (default `CO`), so the same fixture sent to both is how per-line isolation gets checked. `--from <number>` picks the customer number; by default it is the first entry of that line's allowlist, which means the agent replies for real over WhatsApp.

### RAG system (`src/modules/rag-docs/`)

Product datasheets and FAQs are stored with `pgvector` embeddings in the `rag_docs` table. `RagDocService.search()` runs cosine-similarity queries via the `<=>` operator (similarity threshold 0.6, or 0.38 for FAQ-only fallback). Load documents from `data/` with `npm run rag:load`.

### Payments

- **Bold** (Colombia): `https://integrations.api.bold.co/online/link/v1`, authenticated via `x-api-key`
- **PayPhone** (Ecuador): `https://pay.payphonetodoesposible.com/api/Links`

### PDF generation

Billing and quote PDFs are rendered with `@react-pdf/renderer` inside `src/modules/docs/`.

## Coding guidelines

See [CLAUDE.md](CLAUDE.md) for the full set of architecture rules and conventions. In short:

- Strict layering: Route → Controller → Service → Model
- Controllers and Services must be classes; services receive models via constructor injection
- No business logic in routes or controllers; no direct model access from controllers
- API responses are in Spanish; logs and commit messages are in English
