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

**Message buffering**: Incoming messages are held in a `Map<phoneNumber, BufferEntry>` for `BUFFER_WAIT_MS` (7 s) to accumulate rapid multi-part messages before processing them as one turn.

**Session state in Redis**: Each user session (`UserSession`) is serialized to Redis with a 2-hour TTL (`SESSION_TTL_SECONDS`). Sessions track cart, active flows, last product list, country info, and conversation flags.

**Country detection**: Determined from the phone number prefix at message time. Colombia (+57) → COP currency, Bold payment links. Ecuador (+593) → USD currency, PayPhone payment links. Override available via `TEST_FORCE_COUNTRY_ISO` env var.

**Service decomposition inside the module**:

- `WhatsAppAgentService` — main entry point; owns the buffer and queue
- `OpenAIService` (`openai.service.ts`) — wraps OpenAI chat completions and embeddings; holds the Gema system prompt
- `FlowsService` — stateful multi-step flows: quote creation and purchase checkout
- `IntentHandlerService` — dispatches incoming intents to the correct flow or fallback
- `CountryService`, `ProductSearchService`, `MediaHandlerService` — specialized agent sub-services
- `PaymentLinkService` — generates Bold (Colombia) or PayPhone (Ecuador) payment URLs
- `WhatsAppLogService` + log models — persists message, query, and error logs to DB

**Intent detection** (`helpers/intent-detection.ts`): deterministic regex rules run first; if no match, falls back to OpenAI classification.

### RAG System (`src/modules/rag-docs/`)

Product datasheets and FAQs are stored as text with pgvector embeddings in the `rag_docs` table. `RagDocService.search()` performs cosine-similarity queries using `pgvector`'s `<=>` operator. Documents are loaded with `npm run rag:load` (reads from `data/`). Similarity threshold: 0.6 (0.38 for FAQ-only fallback).

### Multi-country payment integrations

- **Bold** (Colombia): REST API call to `https://integrations.api.bold.co/online/link/v1`, authenticated via `x-api-key` header
- **PayPhone** (Ecuador): REST API call to `https://pay.payphonetodoesposible.com/api/Links`
- Test env vars `TEST_PAYPHONE_IN_CO` and `TEST_FORCE_COUNTRY_ISO` override country logic for local testing

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
