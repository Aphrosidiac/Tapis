# Tapis

*Tapis* — Malay, to sift. A self-hosted web app that reads the WhatsApp chats
you choose, ignores the chatter, and turns the real requests, complaints, bug
reports and change requests into clear items you can act on: on a dashboard,
and on your own WhatsApp.

Built for a software house drowning in client groups where every message
arrives in Malay, English, Chinese, or all three in one sentence. Nothing in
it is wired to that business: chats, context, tracking rules, output language,
models and destinations are all configured by whoever runs it.

```
WhatsApp  ─▶  only the chats you chose  ─▶  cheap filter  ─▶  capable analysis  ─▶  items
                (everything else                 (most of it            (only what              dashboard
                 is dropped, not                  is noise)              survived)              + WhatsApp
                 stored at all)
```

---

## Contents

- [What it does](#what-it-does) · [The ten steps](#the-ten-steps)
- [Running it locally](#running-it-locally) · [Stack](#stack)
- [The WhatsApp channel](#the-whatsapp-channel) — and the four traps that cost a day
- [The pipeline](#the-pipeline) · [Rules](#rules) · [Cost](#cost)
- [Data model](#data-model) · [API](#api) · [Settings](#settings)
- [Design](#design) · [Testing](#testing) · [Deployment](#deployment)
- [What is deliberately not done](#what-is-deliberately-not-done)

Deeper documents live in [`docs/`](docs/): [architecture](docs/architecture.md),
[the WhatsApp channel](docs/whatsapp.md), [the pipeline](docs/pipeline.md),
[API reference](docs/api.md), [design system](docs/design-system.md),
[deployment](docs/deployment.md).

---

## What it does

A business owner is in thirty WhatsApp groups. Somewhere in today's four
hundred messages are two feature requests, a complaint and a question about an
invoice. The rest is "ok", "noted", "boss", and a sticker.

Tapis watches only the chats you point it at, reads them with the context you
give it, and produces an item for each real thing — with a title, a plain
brief, suggested next steps, and the exact original messages attached. The same
issue raised three times over four days by two people is **one item that gets
updated**, not three duplicates.

### The ten steps

1. **Connect WhatsApp.** Tapis links as a device on your existing account, the
   way WhatsApp Web does. Your groups and chats become visible inside the app.
2. **Choose which chats to read.** Everything not chosen is ignored completely.
   Not analysed, not stored — the message is seen by the socket and dropped.
3. **Describe each chat.** Who the client is, what the project is. The models
   read this before every message.
4. **Set what to track**, in plain language. "Track feature requests from this
   group." "Track complaints from Ahmad only." "Flag anything about payments."
   Free-form on purpose: the sentence *is* the category. A rule can cover the
   whole chat or named people, a chat can have several, one message can match
   more than one, and each rule chooses where its results go — the dashboard, a
   WhatsApp number, or both.
5. **Collect messages** exactly as sent: original text, sender, time, chat.
6. **First pass — the cheap filter.** Messages are bundled per chat and a cheap
   model answers one question: given this chat's context and rules, is anything
   here worth tracking? Most is dismissed. When unsure it flags, because a
   missed complaint costs more than a false alarm.
7. **Second pass — the analysis.** Only what survived reaches the capable
   model, with the exact originals and the filter's reasons. It writes the
   title, brief, suggestion, and anything else the rule asked for.
8. **Group into items.** Follow-ups attach to the existing item. "Is this done
   yet?" becomes a status check on the item it belongs to, and reopens it if it
   had been closed.
9. **Output.** The dashboard, grouped by client, chat or rule; and WhatsApp, to
   the numbers each rule names.
10. **Review what was dismissed.** Rescue anything wrongly ignored. The
    correction is shown to the filter as an example from then on.

### Principles

- **Originals are never altered.** An item always shows exactly what was said.
- **Multilingual in, one language out.** Any mix of Malay, English and Chinese;
  briefs in the language you chose.
- **Cost-aware.** Cheap filtering first; the expensive model only on what
  survives. Every call is priced on the dashboard.
- **Configurable, not hardcoded.** Chats, context, rules, destinations,
  provider, models and keys are all operator settings.

---

## Running it locally

Requires Node 22+ and PostgreSQL.

```bash
createdb tapis
cd backend && cp .env.example .env      # set DATABASE_URL and JWT_SECRET
npm install && npx prisma db push
npm run dev                              # API on :3140
```

```bash
cd frontend && npm install && npm run dev   # UI on :5140, proxies /api
```

Open <http://localhost:5140>. The first visit creates the operator account —
there is no seeded default password to forget to change.

Then: add a model key on **Settings**, link WhatsApp on **WhatsApp link**,
switch on chats and write rules on **Chats & rules**.

### Working without an account or credit

Outside production, Settings offers a **Mock** provider. It calls no model and
every brief it writes says MOCK. It exists so the whole pipeline — bundling,
items, follow-up attachment, deliveries, rescue — can be exercised on a machine
with no API credit.

Each tracked chat also gets an **inject a message** box (always in development,
opt-in in production) so a rule can be tested without a phone.

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Fastify 5 + TypeScript (ESM), single process |
| Database | PostgreSQL via Prisma 6 |
| WhatsApp | [baileys](https://github.com/WhiskeySockets/Baileys) 6.7.24, linked device |
| Models | Anthropic SDK (structured outputs) **or** OpenRouter; dev-only mock |
| Frontend | Vue 3 + Vite + Tailwind v4 + Pinia |
| Type | Manrope (self-hosted), with a CJK fallback stack |
| Process | PM2, **fork mode, one instance** |

Deliberately one process. Only one process may hold a WhatsApp session, and
PM2 cluster mode has burned sibling projects through bcryptjs.

---

## The WhatsApp channel

Tapis is a **linked device** on an ordinary account. No Meta review, no number
registration — and no delivery guarantees, plus a session the phone can revoke
at any moment.

The known failure of a linked device is not that it breaks. It is that it
breaks **quietly**: the phone unlinks, the socket dies, the process keeps
answering health checks, and nobody notices until a client complains. So this
module is built to be loud:

- One state per real situation. `failed` and `logged-out` are distinct from
  `reconnecting`, because they need a person and a status stuck on
  "reconnecting" forever hides that.
- A watchdog compares `sock.ws.isOpen` against our own belief every 30s.
  `state === 'connected'` is a memory; the socket is the truth.
- **Sending while not connected throws.** Never a silent success, never a quiet
  fall back to the mock. A failed send is a FAILED row with its reason.
- The account is never marked online, so your phone keeps its notifications.
- Unlinking tells WhatsApp before deleting the keys. Deleting alone leaves a
  ghost device holding one of your four slots, and only the phone can remove
  it.

### Four traps that were each invisible until measured

These cost real time on a real account. They are written up in full in
[`docs/whatsapp.md`](docs/whatsapp.md); the short version:

1. **`@lid` addressing.** A one-to-one chat can arrive as `8094…@lid` instead
   of a phone number, with the number beside it in `key.senderPn`. The obvious
   guard (`endsWith('@s.whatsapp.net')`) silently discards **every** customer
   message while the socket stays perfectly healthy.
2. **`syncFullHistory: false` switches off the entire history sync.** Baileys
   defaults `shouldSyncHistoryMessage` to that flag, so it also answers false
   for the initial and recent syncs. `messaging-history.set` then never fires —
   and it is the only source of the chat list, the last-message times, and
   every one-to-one chat. Keep `shouldSyncHistoryMessage: () => true`.
3. **The chats in that sync carry no timestamp.** Measured on a real account:
   905 chats and 58,293 messages, and not one `conversationTimestamp`. The
   times are on the messages. Derive them per jid and take the newest.
4. **The address book arrives before the chats it names.** Saved names come
   through the *app-state* sync, which runs right after pairing — before any
   chat exists. Applying a name only to an existing chat throws the whole
   address book away. Contacts get their own table, written on arrival.

Every one of those had the same shape: a handler that quietly did nothing, with
no log on the success path. Both sync handlers now log what they received.

---

## The pipeline

A tick runs every 10 seconds (`PIPELINE_TICK_MS`) and does three things: cut
bundles that are due, run each through both passes, send whatever is queued for
WhatsApp. Bundles run one at a time so model calls never stampede.

### Bundling

Messages are judged in batches, so a burst of short lines reads as one thought.
A batch is cut for a chat when **any** of these is true:

| Trigger | Default | Setting |
|---|---|---|
| The chat has gone quiet | 60s | `bundleQuietSeconds` |
| Enough messages are waiting | 15 | `bundleMaxMessages` |
| The oldest has waited too long | 300s | `bundleMaxWaitSeconds` |

Plus `manual` (**Run now**) and `rescue` (one rescued message, straight to
analysis).

### Whose side is talking

The models are told who is on the business's side, and they are told by a
list, not by guessing. **Settings → Your team** shows every sender the link
has seen across the tracked chats — name, number, how many of your groups
they are in — with a switch; the same switch is on each chat's people list.
It keys on the sender id the link actually saw (a number, or the `lid:` id
of a sender that never carried one), never on a name.

A team member's message is stored like the linked phone's own: `SKIPPED`,
"Sent by our team", context for both passes and never a candidate. In the
transcript they read `Noel [our team]`, and the analysis prompt says what
that means: "I will add that button" from your side is a commitment, not a
client asking for a button — attach it, do not open an item for it.

### Reading the media first

Before a bundle is judged, every voice note in it is **transcribed** and every
image is **described**, once, and the reading is stored on the message beside
the untouched original (`mediaText`). Both passes then read words, not
"[voice note]" — a screenshot of an error dialog or a spoken "tolong tambah
button tu" counts on its own, where before it was flagged or dropped on its
neighbours alone.

- Voice notes: verbatim, in whatever mix of Malay, English and Chinese was
  spoken, code-switching kept. The Anthropic API takes no audio, so this one
  call always goes through **OpenRouter** (`transcribeModel`, default
  Gemini 3.8 Flash — well under a cent for a 30-second note) and needs that
  key whatever the provider setting says.
- Images: a factual description plus any text read from the picture, in the
  output language, written by the filter model. Independent of
  `analyzeImages`, which sends the actual pixels to the analysis model as well.

Anything with Chinese in it — the message, a transcript, an image reading —
also gets a translation into the output language, stored beside the original
and shown under it (`textTranslation`, `mediaTextTranslation`). One cheap
call per bundle by the filter model, for the reader only; the models read
the original. **Translate** appears on any Chinese line that has none. The
field is deliberately not called a "reading": asked for a *reading* of
Chinese, the model returned pinyin.

A read that fails is recorded on the message with its reason and never stops
the bundle; the transcript line says what could not be read and why. Every
reading is shown under the message on the item, chat and review screens with
**Read again**, and both readings can be switched off on Settings.

### The two passes

**Filter** — cheap model, one decision per message, plus a short reason and the
rules it may match. It sees the chat context, the active rules, recent
conversation for context, and up to 12 recent operator corrections as examples.
A message the model forgets to decide on is **flagged, not dropped**: the
default has to be the safe side.

**Analysis** — capable model, only on flagged messages, with the exact
originals and the filter's reasons. It returns actions: `create`, `attach` (to
an open item, as a status check, more detail, or a follow-up), or `ignore`.
Every flagged id must appear in exactly one action; leftovers are dismissed
visibly rather than lost. A DONE item that gets a follow-up is reopened.

Both passes use structured outputs and are **re-validated with Zod on our
side**. A provider's "strict" is a hope, not a guarantee.

### Rules

Free-form text, because a fixed list of categories is what makes these tools
useless. A rule carries:

- the sentence itself, read as-is by both models;
- an optional "also produce" ask, answered as labelled fields on the item;
- optional senders, so a rule can watch one person in a busy group;
- destinations: dashboard, WhatsApp numbers, or both.

### Cost

Every model call is recorded with its token counts and priced. The dashboard
shows 7- and 30-day spend; Review shows per-run tokens and latency. The whole
point of the cheap first pass is that the expensive model only ever sees what
survived it.

---

## The assistant

A chat with the whole system, in the sidebar. It sees everything Tapis holds
— chats, messages with transcripts and translations, items, pipeline runs,
settings, spend — and answers from the data, never from memory: every claim
comes back from a tool call you can open and read.

The loop is ours, not a provider's, so it runs on any tool-calling model on
OpenRouter. The default is **DeepSeek V4 Flash** (`agentModel`): a turn that
reads the state, opens three items and searches two chats costs about a
tenth of a cent. What makes a cheap model reliable is the harness:

- **Typed, tiered tools.** No shell. Every capability is a dedicated tool
  with a Zod schema; a bad call becomes an error result the model can read,
  never a crash. `read` tools run freely and in parallel; `write` and
  `outward` tiers (next phases) are logged with before/after and gated.
- **`sql_query`** for the long tail: one read-only `SELECT`, in a read-only
  transaction with a 5s limit and a 200-row cap, over a documented schema
  (`describe_schema`). `users` and `app_settings` are not reachable.
- **Append-only transcript.** Every message the model saw or wrote is a row
  in `agent_messages`, stored before the next request. Reloading shows the
  same conversation; a reconnect resumes the same stream by event id.
- **Budgets.** 24 steps and 40K output tokens per turn, with a wrap-up nudge
  before the hard stop; 30s per tool call.
- **Escalation.** Two consecutive steps of invalid tool calls, or a provider
  error, hand the turn to `agentEscalationModel` (DeepSeek V4 Pro by default).
- **Cache-friendly prompt.** A frozen system prompt first, a small live brief
  (link state, counts, the time) second, then the transcript — DeepSeek's
  prefix cache reads the prefix at a fifth of the input price.
- **Untrusted content.** The prompt and the tool descriptions both say it:
  what a client wrote is data, not instructions.

Every call lands in `llm_calls` as kind `AGENT`; the thread header shows
tokens and cost. Reasoning is shown behind a disclosure; tool calls are
cards that open to the exact input and result.

Next: write tools with approval cards and undo, then the memory layer
(operator preferences, per-client notes, learned procedures, nightly
consolidation), then evals from real threads.

## Data model

| Model | What it is |
|---|---|
| `User` | The operator. One per install. |
| `AppSetting` | Operator settings and encrypted secrets. |
| `Contact` | The address book, kept apart from the chat list — most contacts have never been messaged. |
| `Chat` | A group or private chat, with the operator's context and whether it is read. |
| `Participant` | Someone who has spoken in a chat; what rules can be scoped to. |
| `Rule` | A tracking rule. |
| `Message` | The exact original. Never rewritten. |
| `Bundle` | One pass of the pipeline over a batch, with its trigger and outcome. |
| `LlmCall` | Every model call, with tokens, latency and errors. |
| `Item` | The actionable thing. |
| `ItemMessage` | Which messages back an item, and how (origin, detail, status check, follow-up). |
| `ItemEvent` | The item's timeline. |
| `Delivery` | A queued or sent WhatsApp message for an item. |
| `Feedback` | Operator corrections, shown to the filter as examples. |

A chat is keyed on its jid; a person on their phone number, or on `lid:<id>`
when WhatsApp gives no number. Never on the LID when a number exists — see
[`docs/whatsapp.md`](docs/whatsapp.md).

---

## API

Full reference in [`docs/api.md`](docs/api.md). Everything except
`/api/auth/*` and `/api/health` requires a bearer token.

| Area | Endpoints |
|---|---|
| Auth | `GET status`, `POST setup`, `POST login`, `GET/PUT me` |
| WhatsApp | `GET status`, `POST link`, `pair-code`, `stop`, `unlink`, `refresh-groups`, `resync-contacts` |
| Chats | `GET /chats`, `GET/PUT /chats/:id`, `GET /chats/:id/messages`, `POST /chats/:id/run` |
| Rules | `POST /chats/:id/rules`, `PUT/DELETE /rules/:id` |
| Items | `GET /items` (views: `chased`, `stale`, `urgent`), `GET/PUT /items/:id`, `POST /items/:id/send` |
| Review | `GET dismissed`, `POST rescue/:id`, `GET bundles`, `POST bundles/:id/retry`, `GET/DELETE feedback` |
| Ops | `GET /dashboard`, `GET /notices`, `GET/PUT /settings`, keys, `POST /settings/test` |
| Dev | `POST /simulate`, `POST /pipeline/run`, `GET /media/:messageId` |

---

## Settings

Everything an operator can change without touching a file on the server —
because "edit a dotfile and restart the API" is not an instruction the person
running a business can act on.

Business name · output language (en/ms/zh) · timezone · provider (Anthropic,
OpenRouter, or dev-only mock) · API keys · filter model · analysis model ·
the four bundling numbers · whether images go to the analysis model · whether
images are described and voice notes transcribed before judging, and with
which model · whether simulation is allowed in production.

**Keys are encrypted at rest** with AES-256-GCM and never sent back to the
browser — the screen gets a boolean and a four-character tail. An empty field
means "leave it alone"; clearing needs an explicit request. The environment is
a per-field fallback, so an install configured through `.env` keeps working.

### Environment

```
DATABASE_URL      required
PORT              default 3140
JWT_SECRET        required; production refuses to boot on the example value
NODE_ENV
ANTHROPIC_API_KEY optional, or set it on the Settings screen
OPENROUTER_API_KEY optional
CREDENTIAL_KEY    optional; generated to a 0600 .credential-key if unset
PIPELINE_TICK_MS  default 10000
WA_WATCHDOG_MS    default 30000, lowered by tests
WA_SESSION_DIR    ignored in production, on purpose
BAILEYS_DEBUG=1   socket traffic on stderr
```

---

## Design

The SmoothSail / RackForge system: an ink ramp on a near-white ground,
hairline card borders carrying a soft shadow, 6/10/14 radii, 15px body. Set in
**Manrope**, deliberately not the Hanken Grotesk the siblings use, chosen by
rendering the real screens under six candidates — two were disqualified because
their tabular figures space punctuation and "RM 12,480.50" came apart. The font
stack carries CJK fallbacks: clients write in Chinese and no Latin variable
font covers a single one of those glyphs.

The primary action is ink, never the accent: white on the teal measures 4.2:1
and fails AA for a 15px label.

The dashboard is **triage, not metrics**. Three questions, each a filter you
can click — who is chasing you, what have you left sitting, what is urgent —
because a count you cannot act on is not worth the top of a screen. Details in
[`docs/design-system.md`](docs/design-system.md).

---

## Testing

```bash
cd backend && npm test        # node:test, no database required
npm run typecheck
```

The suite covers the two parsers that have historically been wrong, using
shapes taken from what a linked device **actually** sent rather than what the
types imply — the inbound parser (LID with and without a number, group
participants, our own messages, the status feed, ephemeral wrappers) and the
history-sync parser (Long decoding in all four shapes, chats timed from
messages, conversations known only from a message, broadcast filtering).

A suite that authors its own input format cannot discover the format reality
uses. That is how the `@lid` bug survived six green suites elsewhere.

Mobile is verified with a scripted 390px device emulation, not by resizing a
window — neither browser on a Mac goes below ~522px. See
[`docs/design-system.md`](docs/design-system.md#verifying-mobile).

---

## Deployment

Self-hosted, PM2 + nginx. Full runbook in
[`docs/deployment.md`](docs/deployment.md).

```bash
cd backend && npm ci && npx prisma db push && npm run build
cd ../frontend && npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save
```

nginx proxies `/` to `127.0.0.1:3140` with `proxy_http_version 1.1`. The
backend serves the built frontend when `frontend/dist` exists.

Keep out of anything served statically — the code already never serves them:

- `backend/.wa-session/` — a complete WhatsApp login
- `backend/.credential-key` — decrypts stored API keys
- `backend/media/` — downloaded client media, behind an authenticated route

**Only one process may hold the WhatsApp session.** Never run two copies
against the same session directory, and never PM2 cluster mode.

---

## Changelog

Newest first. Every entry below was driven by a real account, not a plan.

**The assistant, phase 1** — a sidebar chat over the whole system on a
provider-neutral tool loop (DeepSeek V4 Flash by default), thirteen read
tools including read-only SQL, streaming with reasoning and tool cards,
append-only threads, budgets and escalation. First real question — "what
needs my attention" — answered correctly from four steps and seven tool
calls for $0.001.

**Address book and the chat list** — contacts stored in their own table on
arrival, because the app-state sync that carries saved names runs before the
history sync creates the chats they belong to. A *Resync contact names*
button recovers them without re-pairing, by clearing the stored app-state
versions so WhatsApp returns a snapshot rather than an empty patch set. The
chat list no longer caps at 500 rows while the account holds 922, and it
sorts by recency rather than pinning tracked chats above everything.

**History sync** — two bugs in a chain. `syncFullHistory: false` also
switched off the initial and recent syncs, so the chat list, every
last-message time and every one-to-one chat never arrived. Then the chats in
that sync turned out to carry no timestamp at all; the times are on the
messages, which were being discarded. Both parsers now have tests built from
the shapes reality sent.

**Notices** — the dashboard's warning banners became a bell with a count in
the header, so a dead link is visible from every screen rather than one.

**Triage dashboard** — six metric tiles replaced by three questions that are
also filters: who is chasing you, what have you left sitting, what is urgent.

**Mobile** — audited at a true 390px under device emulation. Minimum widths
for touch targets (height alone let every icon button fail sideways), bottom
sheets, safe-area insets, messages-first on chat detail.

**Design system** — moved onto the SmoothSail / RackForge system, set in
Manrope with CJK fallbacks.

**First build** — the ten steps end to end: link, choose chats, describe,
rules, collect, filter, analyse, group into items, dashboard and WhatsApp
output, review and rescue.

---

## What is deliberately not done

- **Video is not watched.** A video arrives as its caption. Voice notes and
  images are read (see the pipeline); video would cost real money per second
  and has not yet been the report.
- **Learning is few-shot, not fine-tuning.** Recent corrections per chat are
  shown to the filter as examples. Honest, cheap, and immediately reversible
  from the Review screen.
- **One operator account per install.**
- **Channels, broadcast lists and status updates are never read.** They are not
  conversations with a client.
- **No job queue.** One process, one tick, bundles processed serially. If the
  volume ever justifies BullMQ, the scheduler is the seam.
