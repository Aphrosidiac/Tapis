# Architecture

One Fastify process, one Postgres database, one Vue app. No queue, no worker,
no second service. The WhatsApp session is the reason: only one process may
hold it, so making a second one is a decision with consequences rather than a
convenience.

```
  WhatsApp  ──socket──▶  lib/whatsapp/baileys.ts
                              │  parseInbound()          lib/whatsapp/inbound.ts
                              ▼
                         handleInbound()                 lib/whatsapp/ingest.ts
                              │   is this chat tracked? ──no──▶ dropped, logged
                              ▼ yes
                         messages (PENDING)
                              │
     every 10s  ─────▶   scheduler.tick()                lib/pipeline/scheduler.ts
                              │
                         cutBundles()                    lib/pipeline/bundle.ts
                              ▼
                         processBundle()
                              ├─ runFilter()             lib/llm/filter.ts    cheap
                              └─ runAnalysis()           lib/llm/analyze.ts   capable
                                      │
                                 applyActions()          lib/pipeline/items.ts
                                      ├─ items, item_messages, item_events
                                      └─ deliveries (PENDING)
                                                │
                         sendPendingDeliveries()  ──────▶ WhatsApp
```

## Directory shape

```
backend/src
  server.ts               composition root: listen, signals, ready
  app.ts                  buildApp({ serve }) — routes, plugins, hooks
  middleware/auth.ts      bearer token, re-reads the user every request
  lib/
    prisma.ts  paths.ts  jwt.ts  secrets.ts  input.ts  settings.ts
    whatsapp/
      baileys.ts          the socket: state machine, watchdog, discovery, send
      inbound.ts          PURE parsing: parseInbound, historyChats, waSeconds
      inbound.test.ts     both parsers, against shapes reality sent
      ingest.ts           what gets stored, and the address book
    llm/
      client.ts           two providers + the mock, one call surface
      models.ts           catalogue, prices, effort support
      prompts.ts          system prompts, transcript format, short ids
      filter.ts           first pass
      analyze.ts          second pass
      mock.ts             dev-only stand-in
    agent/
      provider.ts         streaming chat completions with tools, one wire shape
      tools.ts            the registry: typed, tiered tools
      read-tools.ts       what it can look at, plus read-only SQL
      write-tools.ts      what it can change (audited, undoable) and what waits for approval
      memory.ts           the /memories directory and its six-command tool
      reflect.ts          the nightly consolidation thread
      digest.ts           the morning brief to WhatsApp
      prompt.ts           the frozen system prompt and the live brief
      run.ts              the loop: persist, validate, budget, escalate, stream
    pipeline/
      scheduler.ts        the tick
      bundle.ts           cutting bundles, running both passes
      items.ts            applying the analysis's actions
      deliver.ts          WhatsApp formatting, queue, send
  modules/                one *.routes.ts per screen
frontend/src
  views/                  Dashboard, Item, Chats, ChatDetail, Review, Assistant, WhatsApp, Settings, Login
  components/base/        the primitives
  components/layout/      AppLayout, Sidebar, Navbar, NoticeBell
  stores/                 auth, link, notices
  lib/                    api (axios + interceptors), format
```

## The rules the code follows

**Parsing is pure and tested; effects are not.** `inbound.ts` exports
functions that take a payload and return plain data. Everything that touches
the database or the socket lives elsewhere. This is why the two parsers that
have historically been wrong can be tested without a socket, a database, or a
phone.

**An untracked chat stores nothing.** Not the message, not the sender, not the
text. `handleInbound` returns early with a reason. "Everything not selected is
ignored completely" is a promise the row count keeps.

**Originals are never rewritten.** `Message.text` is what arrived. Briefs,
translations and summaries live on the item. The item page always shows both.

**Nothing fails silently.** Every declined inbound is logged with its jid and
reason. Both sync handlers log what they received, on the success path — the
absence of that line is what made three separate bugs invisible.

**Structured output is re-validated.** A provider's `strict: true` is a hope.
Zod on our side is the authority, and it has caught every schema failure.

## Request flow

```
HTTP → preHandler authenticate → controller (guard clauses, zod where it earns it)
     → prisma, scoped by the resource
     → { data } | { error }
```

There is no tenancy: one operator, one account, one set of chats. If Tapis
ever becomes multi-tenant, every query needs an owner key and this note should
be the thing that stops someone assuming it already has one.

## Boot

`buildApp({ serve })`. Only `server.ts` passes `serve: true`, and only that
starts the scheduler and opens the WhatsApp link. Tests and scripts build the
app without it.

That is deliberate: elsewhere, `buildApp()` opening the socket meant ten test
files connected with the same credentials, and the live link went to
`connectionReplaced` — terminal — 43 seconds into a test run. Connecting is a
serving concern, not a construction one, and putting it in the options covers
the eleventh caller nobody has written yet.

## Frontend

Pinia setup stores, one axios instance with token-inject and 401-redirect
interceptors, lazy routes behind a guard. Pages are thin: they call a store or
the api directly, and compose base components.

Three stores: `auth`, `link` (the WhatsApp socket's published state), and
`notices` (everything that needs a person, polled for the header bell). The
shell polls the link and notices every 20s; the WhatsApp page polls the link
every 3s because a pairing QR goes stale in about twenty.
