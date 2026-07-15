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

## Getting started

```bash
# Install dependencies
npm install

# Configure environment
# Create .env.development (and .env.production / .env.test as needed) — see "Environment variables" below

# Run database migrations
npm run migrate

# Seed initial data (optional)
npm run seed:all

# Start the dev server (hot reload via ts-node-dev)
npm run dev
```

The server logs `✅ Server listening on port <PORT>` once it connects to Postgres and Redis.

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

Config is loaded from `.env.{NODE_ENV}` (e.g. `.env.development`, `.env.production`, `.env.test`) by `src/config/env.ts`. `NODE_ENV` defaults to `development`. Sequelize CLI reads the same files via `config/config.js`.

Copy [`.env.example`](.env.example) to `.env.development` (and `.env.production` / `.env.test` as needed) and fill in real values — it documents every variable, including DB/Redis connection info, JWT secrets, OpenAI, WhatsApp Cloud API, and the Bold/PayPhone/Nequi payment integrations.

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

An AI sales agent that handles customer conversations over WhatsApp for both Colombia and Ecuador.

- **Message buffering**: incoming messages are held per phone number for `BUFFER_WAIT_MS` (7s) to merge rapid multi-part messages into a single turn.
- **Session state**: each `UserSession` (cart, active flow, last product list, country, flags) is serialized to Redis with a 2-hour TTL.
- **Country detection**: derived from the phone prefix — Colombia (`+57`, COP, Bold) vs Ecuador (`+593`, USD, PayPhone). Overridable for testing via `TEST_FORCE_COUNTRY_ISO`.
- **Sub-services**: `WhatsAppAgentService` (entry point/queue), `OpenAIService` (chat + embeddings, owns the Gema system prompt), `FlowsService` (quote & checkout flows), `IntentHandlerService` (intent dispatch), `CountryService`, `ProductSearchService`, `MediaHandlerService`, `PaymentLinkService`, `WhatsAppLogService`.
- **Intent detection**: deterministic regex rules first (`helpers/intent-detection.ts`), falling back to OpenAI classification.

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
