# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (ts-node-dev with hot reload)
npm run dev

# Build TypeScript to dist/
npm run build

# Run production build
npm start

# Database migrations
npm run migrate                            # run all pending
npm run migrate:undo                       # undo last migration
npm run generate:migration -- <name>       # scaffold a new migration

# Seeders
npm run seed:all
npm run seed -- <seeder-file>

# Load RAG documents into pgvector
npm run rag:load

# No test suite — test script exits with error
```

## Architecture

### Stack

- **Runtime**: Node.js + Express + TypeScript (compiled to CommonJS, `dist/`)
- **Database**: PostgreSQL via Sequelize ORM; migrations managed by `sequelize-cli`
- **Cache/Sessions**: Redis (ioredis) — used primarily for WhatsApp agent session state
- **AI**: OpenAI API (embeddings + chat completions)

### Environment

Config loaded from `.env.{NODE_ENV}` (e.g. `.env.development`, `.env.production`, `.env.test`) by `src/config/env.ts`. All env vars are exported from `ENV` there. Sequelize CLI uses `config/config.js` (CommonJS wrapper that reads the same env files).

### Startup and process diagnostics

`src/index.ts` connects to Postgres and Redis, then listens. It also registers process-level handlers (`uncaughtException`, `unhandledRejection`, `SIGINT`/`SIGTERM`, `beforeExit`, `exit`) and an `error` handler on the HTTP server, so no exit is silent: `app.listen` reports `EADDRINUSE` asynchronously, outside the `try`, and a drained event loop makes `ts-node-dev` exit with code 0 printing nothing. The `dev` script therefore uses `--respawn`. Any new fatal path must log and `process.exit(1)` rather than return and leave the reconnect interval running without a listener.

Postgres and Redis are not in this repo. They live in their own compose projects in `D:\workspace\infra\postgres-local\` (port 5433) and `D:\workspace\infra\redis-local\` (port 6379), shared with other projects on the machine.

### Module convention

Every feature lives in `src/modules/{name}/` and follows the same pattern:

- `routes.ts` — Express Router
- `controller.ts` — thin handler that calls the service
- `service.ts` — business logic; receives model(s) via constructor injection
- `model.ts` — Sequelize model class + associations defined at bottom of file
- `types.ts` — module-specific TypeScript types

All Sequelize associations are declared at the bottom of the `model.ts` file that owns the "has-many" side. Cross-cutting association helpers live in `src/modules/associations/`.

### Routing & Auth

`src/routes.ts` mounts all routers. Public routes (`/auth`, `/whatsapp-agent`) are registered before `router.use(verifyJWT)`. Everything after that middleware requires a valid JWT Bearer token. The decoded user ID is attached to `req.requestedBy`.

### WhatsApp Agent (`src/modules/whatsapp-agent/`)

The most complex module — an AI sales agent named "Gema". Key architectural decisions:

**Webhook demultiplexing**: `receiveMessage` dispatches on `changes[].field`. `messages` is a customer message; `smb_message_echoes` is a message the staff sent from WhatsApp Business App or WhatsApp Web (Coexistence), which signals human intervention. Every entry/change/message array is iterated — batched webhooks carry more than one. Unknown fields and the `history`/`smb_app_state_sync` envelopes are ignored. Every `wamid` passes through `AiStateService.markSeen` so Meta's retries don't produce a second reply.

**Lines (`lines.ts`)**: one WhatsApp line = one operation. The `phone_number_id` from the webhook determines country, shop, inventory and currency — **never the customer's phone prefix**, since a customer can write to any line. A line whose `WHATSAPP_LINE_*_PHONE_NUMBER_ID` is unset is not registered and its events are ignored (fails closed). Redis state (`session:*`, `wa:ai-pause:*`) is namespaced by `phoneNumberId`, so the same customer on two lines is two independent conversations.

**AI / human coexistence (`agent-services/ai-state.service.ts`)**: an echo pauses the AI for that conversation (`wa:ai-pause:<phoneNumberId>:<phone>`, TTL `WHATSAPP_AI_PAUSE_TTL_SECONDS`, renewed on every staff message). The same pause is applied when the customer asks for a person: the agent sends its handover message and then steps aside. That pause is set *after* `sendReply`, because `sendReply` suppresses any message on a paused conversation and pausing first would swallow the handover message itself. The request is caught in two places — the NLU intent `human_handoff`, and `isExplicitHumanRequest` checked *before* the purchase/quote interceptors, since those answer before the NLU ever runs and would otherwise keep asking a stuck customer for their ID. Out of office hours the handover message says so instead of promising immediate attention. The pause record carries a `reason` (`human_reply` | `customer_request`), and pausing always clears `pendingPurchaseFlow`/`pendingQuoteFlow` so a resumed conversation never picks up a form a person already settled — an invariant re-checked at the end of every turn, not left to the session TTL outliving the pause. Reactivation is purely the TTL expiring — there is no resume endpoint or command by design. Messages arriving during a pause are logged as history but never buffered: when the pause lapses they are not processed retroactively. Because Meta puts no origin flag on echoes, every agent send registers its `wamid` (`wa:self-send:*`) so the agent never mistakes its own message for a human one. `sendReply` re-checks the pause before sending, which closes the window where staff replies mid-turn — a turn takes the buffer debounce plus the LLM call plus `REPLY_DELAY_MS`, so that window is many seconds wide.

**Test allowlist**: per line, `WHATSAPP_LINE_*_AI_ALLOWLIST` + `_ENABLED` (default `true`) restricts AI replies to listed numbers; everyone else keeps human-only attention. A permanent denylist (the line's own number plus `SHOP_NOTIFY_CO_PHONE`/`SHOP_NOTIFY_EC_PHONE`) always wins, since the panel sends those shop numbers a copy of every quote and invoice PDF and their replies are not customer messages.

**Message buffering**: Incoming messages are held in a `Map<phoneNumber, BufferEntry>` for `BUFFER_WAIT_MS` (see `constants.ts` — it is still being tuned against real conversations) to accumulate rapid multi-part messages before processing them as one turn. It is a trailing debounce: each new message restarts the timer. An echo discards the pending buffer for that customer.

**Session state in Redis**: Each user session (`UserSession`) is serialized to Redis with a 2-hour TTL (`SESSION_TTL_SECONDS`). Sessions track cart, active flows, last product list, country info, and conversation flags.

**Operating context** (`agent-services/country.service.ts`): `resolveForLine(line)` loads the shop by the line's `shopSlug` and returns `CountryContext { currency, stockIds, shopId, isoCode }`, which scopes catalog, prices and inventory. Colombia → COP + Bold/Nequi; Ecuador → USD + PayPhone. It is driven by the line, not by the customer's prefix, so a `+593` customer writing to the Colombian line is served Colombian stock and prices. `TEST_FORCE_COUNTRY_ISO` was removed: forcing a country per message would mix operations. To exercise another country, configure its line or replay a fixture with its `phone_number_id`.

**Service decomposition inside the module**:

- `WhatsAppAgentService` — main entry point; owns the buffer and queue
- `OpenAIService` (`openai.service.ts`) — wraps OpenAI chat completions and embeddings; holds the Gema system prompt
- `FlowsService` — stateful multi-step flows: quote creation and purchase checkout
- `IntentHandlerService` — dispatches incoming intents to the correct flow or fallback
- `CountryService`, `ProductSearchService`, `MediaHandlerService` — specialized agent sub-services
- `PaymentLinkService` — generates Bold (Colombia) or PayPhone (Ecuador) payment URLs
- `WhatsAppLogService` + log models — persists message, query, and error logs to DB. All three tables carry `botPhoneNumberId`, so every row is attributable to a line. On `whatsapp_message_log`, `source` (`customer`/`ai`/`human`) separates what the agent sent from what a person sent, and skipped inbound messages are recorded with `intent` set to `skipped:paused` / `skipped:allowlist` / `skipped:denylist`.

**Intent detection**: a single OpenAI call (`detectIntentWithAI`) is the only classifier — the old regex rule engine was removed. `helpers/intent-detection.ts` now holds only `stripCallingCode` and `isFarewellOnly`. If the LLM call fails, the fallback is a lone-integer regex → `select_product`, otherwise `product_followup`/`greeting`.

### Testing the webhook

No automated test suite. `npm run wa:replay -- <fixture>` POSTs a real-shaped payload at the local webhook; `scripts/wa-fixtures/README.md` lists each fixture and what it should prove. The fixtures carry no line of their own: `__LINE_PHONE_NUMBER_ID__`, `__LINE_BUSINESS_PHONE__`, `__CUSTOMER_PHONE__` and `__SHOP_PHONE__` are resolved from `.env` at send time, so changing the line never leaves them pointing at a dead `phone_number_id` — which would make every replay return 200 while the agent silently ignored it. A missing value aborts the send instead. Timestamps are rewritten to "now" on each run (the agent drops messages older than 5 min); `wamid`s are kept, so replaying a fixture twice exercises the dedup path.

### RAG System (`src/modules/rag-docs/`)

Product datasheets and FAQs are stored as text with pgvector embeddings in the `rag_docs` table. `RagDocService.search()` performs cosine-similarity queries using `pgvector`'s `<=>` operator. Documents are loaded with `npm run rag:load` (reads from `data/`). Similarity threshold: 0.6 (0.38 for FAQ-only fallback).

### Multi-country payment integrations

- **Bold** (Colombia): REST API call to `https://integrations.api.bold.co/online/link/v1`, authenticated via `x-api-key` header
- **PayPhone** (Ecuador): REST API call to `https://pay.payphonetodoesposible.com/api/Links`
- `TEST_PAYPHONE_IN_CO` forces PayPhone even for Colombia, for local testing. `TEST_FORCE_COUNTRY_ISO` was removed: the line decides the country.

### PDF generation

`@react-pdf/renderer` is used (with React 18 as a peer dep) to generate billing and quote PDFs inside `src/modules/docs/`.

---

## Coding Guidelines

### General Principles

- Always follow the existing architecture and module patterns
- Prefer reusing existing services before creating new ones
- Keep code clean, modular, and DRY
- Do not add new dependencies unless strictly necessary
- Follow TypeScript best practices used in the project

---

### Architecture Rules

This project follows a layered modular architecture:

Route → Controller → Service → Model

#### Routes

- Define Express endpoints
- Instantiate Service and Controller
- Must NOT contain business logic

#### Controllers

- Must be classes
- Receive service via constructor injection
- Handle request/response only
- Must NOT access Sequelize models directly

#### Services

- Must be classes
- Contain business logic
- Interact with database via Sequelize models
- Receive models via constructor injection

#### Models

- Define Sequelize schema and associations
- Must NOT contain business logic

---

### Module Structure

Each module inside `src/modules/{name}` must follow:

- routes.ts
- controller.ts
- service.ts
- model.ts
- types.ts

---

### Patterns

#### Route Pattern

- Import Router
- Import Model
- Import Service
- Import Controller
- Instantiate Service with Model
- Instantiate Controller with Service
- Register controller methods

#### Controller Pattern

- Use class-based controllers
- Handlers must be class properties (not standalone functions)

---

### Rules

- Do NOT put business logic in routes
- Do NOT access models from controllers
- Controllers and Services must be classes
- Always follow existing module structure

---

### Additional Conventions

- API responses must be in Spanish
- Logs must be in English
- Commits must be written in English

---

### Code Generation Guidelines

When generating code:

- Analyze existing modules in `src/modules`
- Replicate existing patterns exactly
- Prefer consistency over creativity
- Avoid unnecessary abstractions

## Caveman Mode

When the user requests "caveman mode":

- Try to read `.agents/skills/caveman/SKILL.md` and follow its instructions
- If the file is not available, apply the following behavior:

  - Use extremely simple language
  - Avoid abstractions and jargon
  - Explain step by step
  - Break complex ideas into small pieces
  - Prefer concrete examples over theory
