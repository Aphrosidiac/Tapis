# Tapis

*Tapis* (Malay: to sift, to filter). A self-hosted web app that reads the WhatsApp
chats you choose, ignores the chatter, and turns the real requests, complaints,
bug reports and change requests into clear, actionable items — on a dashboard,
and on your own WhatsApp.

Built for a software house drowning in client groups in Malay, English and
Chinese. Nothing in it is hard-wired to that: chats, context, rules and
destinations are all yours to define.

## How it works

1. **Link WhatsApp.** Tapis is a linked device on your existing account (like
   WhatsApp Web). Your groups appear at once; private chats appear when they
   next speak. The account is never marked online, so your phone keeps its
   notifications.
2. **Choose chats.** Switch on the ones to read. Everything else is ignored
   completely — not stored, not even logged beyond "ignored".
3. **Describe each chat.** Client, project, who is who. The models read this
   before every message.
4. **Write rules in plain language.** "Track feature requests from this group",
   "Track complaints from Ahmad only", "Flag anything about payments or
   invoices". A rule can ask for extra output ("which module, how severe"),
   apply to specific people, and send matches to the dashboard, a WhatsApp
   number, or both.
5. **Messages are stored exactly as sent** — text, sender, time, chat, media.
6. **First pass, cheap.** Pending messages are bundled per chat (after a quiet
   period, or by size or age) and a cheap model answers one question per
   message: could this be part of something a rule asks for? It leans toward
   flagging. Most of the batch is dismissed as noise.
7. **Second pass, capable.** Only flagged messages reach the capable model,
   with the exact originals, the filter's reasons, the chat context, and the
   items already open. It produces a title, a plain-language brief, suggested
   next steps, and whatever the rule asked for — in the output language you
   chose.
8. **One issue, one item.** The same issue raised again — "is this done yet?",
   extra details, a second person asking — attaches to the existing item as a
   status check, detail or follow-up. Closed items that come back are
   reopened.
9. **Output.** Dashboard grouped by client, chat or rule, with status (new, in
   progress, done, dismissed) and the original messages behind every item.
   WhatsApp delivery to the numbers on each rule, from the linked account.
10. **Review what was dismissed.** Rescue anything wrongly ignored; it goes
    straight to analysis and the filter is shown it as an example from then
    on. Dismissing an item teaches it what noise looks like in that chat.

Every model call is recorded with its token counts, so the cost is a number on
the dashboard, split between the two passes.

## Stack

- **Backend:** Fastify 5 + TypeScript (ESM), Prisma 6, PostgreSQL,
  [baileys](https://github.com/WhiskeySockets/Baileys) 6.7.24 for the WhatsApp
  link, the official Anthropic SDK (structured outputs) or OpenRouter for the
  models. One process; PM2 fork mode.
- **Frontend:** Vue 3 + Vite + Tailwind v4 + Pinia. Built into `frontend/dist`
  and served by the backend in production.
- **Models:** defaults are Claude Haiku 4.5 for the filter and Claude Opus 5
  for analysis. Both are changeable on the Settings screen, as is the provider.

## Run it locally

```bash
createdb tapis
cd backend && cp .env.example .env    # set DATABASE_URL and JWT_SECRET
npm install && npx prisma db push && npm run dev      # API on :3140
cd ../frontend && npm install && npm run dev          # UI on :5140 (proxies /api)
```

Open http://localhost:5140. The first visit creates the operator account. Add a
model API key on **Settings** (or in `.env`), link WhatsApp on **WhatsApp
link**, switch on chats and write rules on **Chats & rules**.

Outside production a **Mock** provider is offered on Settings. It calls no model
and every brief it writes says MOCK — it exists to exercise the pipeline on a
machine with no API credit. Each tracked chat also gets an "inject a message"
box (always in development; opt-in in production) to test rules without a phone.

## Deploy (VPS, PM2, nginx)

```bash
cd backend && npm ci && npx prisma db push && npm run build
cd ../frontend && npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save
```

nginx: proxy `/` to `127.0.0.1:3140` with `proxy_http_version 1.1`, and
`client_max_body_size 5M`. Production refuses to boot without a real
`JWT_SECRET`. Keep `backend/.wa-session/` (a complete WhatsApp login),
`backend/.credential-key` (encrypts stored API keys) and `backend/media/` out
of anything served statically — the code already never serves them.

**Only one process may hold the WhatsApp session.** Do not run two copies
against the same `.wa-session`, and do not use PM2 cluster mode.

## Layout

```
backend/src
  lib/whatsapp/   baileys.ts (link, watchdog, discovery), inbound.ts (parsing,
                  LID handling), ingest.ts (what gets stored)
  lib/llm/        client.ts (providers), prompts.ts, filter.ts, analyze.ts,
                  models.ts (catalogue + prices), mock.ts (dev only)
  lib/pipeline/   bundle.ts (cut + two passes), items.ts (apply actions),
                  deliver.ts (WhatsApp formatting + sending), scheduler.ts
  modules/        one *.routes.ts per screen
frontend/src
  views/          Dashboard, Item, Chats, ChatDetail, Review, WhatsApp, Settings
  components/     base/ primitives, layout/, RuleModal
```

## Not yet

- Voice notes are stored and shown, not transcribed. Images are stored, shown,
  and (optionally) sent to the analysis model.
- Learning is few-shot: recent corrections per chat are shown to the filter as
  examples. There is no fine-tuning.
- Single operator account per install.
