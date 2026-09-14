# API reference

Base path `/api`. Every endpoint except `/api/auth/status`,
`/api/auth/setup`, `/api/auth/login` and `/api/health` requires
`Authorization: Bearer <token>` — header only, never a query string. Tokens
last 7 days and every one is retired the moment the password changes. Login
and setup allow 10 attempts a minute per address.

Errors are `{ "error": "a sentence a person can act on" }` with a real status
code. A 500 says only "Something went wrong on the server"; the detail is in
the log, not in the browser.

---

## Auth

One operator per install. The first visit creates the account, so there is no
seeded default password.

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/status` | `{ needsSetup }` |
| POST | `/auth/setup` | `{ email, password, name }` → `{ token, user }`. 409 once an account exists. |
| POST | `/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/auth/me` | the signed-in user |
| PUT | `/auth/me` | `{ name?, currentPassword?, password? }` → `{ user, token? }` — a new `token` comes back when the password changed, because the old one is now dead |

Tokens are JWTs valid for 7 days. The user row is re-read on every request, so
a deleted account stops working immediately.

---

## WhatsApp

| Method | Path | Notes |
|---|---|---|
| GET | `/whatsapp/status` | the full link state — see below |
| POST | `/whatsapp/link` | start pairing, or reconnect a saved session |
| POST | `/whatsapp/pair-code` | `{ number }` → an 8-digit code instead of a QR |
| POST | `/whatsapp/stop` | pause, keeping the session |
| POST | `/whatsapp/unlink` | tell WhatsApp, then delete the keys |
| POST | `/whatsapp/refresh-groups` | re-fetch every joined group |
| POST | `/whatsapp/resync-contacts` | re-pull the address book → `{ contacts, applied }` |

`GET /whatsapp/status` returns `installed`, `state`, `socketOpen`, `ready`,
`hasSession`, `qr`, `pairingCode`, `pairingExpiresAt`, `me`, `connectedAt`,
`lastInboundAt`, `lastOutboundAt`, `inboundStored`, `inboundIgnored`,
`lastError`, `ghostDevice`, `attempts`, `nextRetryAt`, and `action` — a
sentence saying what a person should do, or null.

`socketOpen` is read fresh from the websocket and reported **beside** `state`
rather than reconciled with it. When they disagree, that disagreement is the
interesting part.

---

## Chats and rules

| Method | Path | Notes |
|---|---|---|
| GET | `/chats` | `?tracked=true\|false&q=` → `{ chats, total }`, most recent first |
| GET | `/chats/:id` | chat with rules, participants and message counts |
| PUT | `/chats/:id` | `{ tracked?, clientName?, description?, name? }` |
| GET | `/chats/:id/messages` | `?status=&q=&page=&limit=` |
| POST | `/messages/:id/read-media` | transcribe / describe the message's media again → `{ message }` |
| GET | `/team` | every sender seen across chats, with `team` flags → `{ people, count }` |
| PUT | `/team/:waId` | `{ team: boolean, name? }` — marks a sender as the business's own; pending messages from them become context |
| POST | `/chats/:id/run` | bundle and process now |
| POST | `/chats/:id/rules` | create a rule |
| PUT | `/rules/:id` | update, or `{ active }` alone to toggle |
| DELETE | `/rules/:id` | items it produced stay |

Switching `tracked` on stamps `trackedSince`; messages older than that are
ignored. `total` is the count in the database, not the length of the page —
the list is capped at 2000 rows.

A rule body is `{ text, extraAsk?, senderWaIds[], toDashboard, toWhatsapp[], active }`.
Numbers are international digits. A rule with no destination is refused.

---

## Items

| Method | Path | Notes |
|---|---|---|
| GET | `/items` | filters below |
| GET | `/items/:id` | with chat, rules, messages, events, deliveries |
| PUT | `/items/:id` | `{ status?, priority?, title?, note? }` |
| POST | `/items/:id/send` | `{ to }` — queue this item to a number now |

Filters: `status` (CSV), `chatId`, `client`, `ruleId`, `priority` (CSV), `q`,
`page`, `limit`, and `view`.

`view` is the triage layer, always over **open** items, and it overrides
`status` — "urgent, but only the ones marked done" is not a question:

| view | means |
|---|---|
| `chased` | the client came back to ask whether it is done |
| `stale` | untouched for `staleHours` (default 48), oldest first |
| `urgent` | priority HIGH or URGENT |

Each row carries `chasedAt`, the last time someone asked about it.

Setting an item to `DISMISSED` records its origin messages as noise for that
chat's filter.

---

## Review

| Method | Path | Notes |
|---|---|---|
| GET | `/review/dismissed` | what the filter threw away |
| POST | `/review/rescue/:messageId` | flag it and analyse immediately |
| GET | `/review/bundles` | pipeline runs, with their model calls |
| POST | `/review/bundles/:id/retry` | re-run a failed one |
| GET | `/review/feedback` | corrections the filter has learned from |
| DELETE | `/review/feedback/:id` | forget one |

Rescuing records the message as an example of what matters, then puts it
through analysis in a bundle of its own.

---

## Dashboard, notices, settings

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard` | item counts, `triage`, cost, link summary, scheduler |
| GET | `/notices` | everything needing a person → `{ notices, count, worst }` |
| GET | `/settings` | settings plus the model catalogue |
| PUT | `/settings` | any subset of the settings |
| POST | `/settings/keys/:provider` | `{ key }`, stored encrypted |
| DELETE | `/settings/keys/:provider` | fall back to the environment |
| POST | `/settings/test` | prove the key works without paying for a completion |

`/notices` reports: no model key, the mock provider selected, a link that is
down or needs a person, a ghost device, failed pipeline runs with the latest
reason, deliveries that gave up, tracked chats with no rules, and a backlog
older than an hour. Each notice has a `tone`, a sentence, and where to go.

Keys are never returned. The settings payload carries `{ configured, source,
hint }` — a boolean, whether it came from the database or the environment, and
a four-character tail.

---

## Development

| Method | Path | Notes |
|---|---|---|
| POST | `/simulate` | inject a message through the real ingest and pipeline |
| POST | `/pipeline/run` | force a tick |
| GET | `/media/:messageId` | stored media, behind auth |

`/simulate` is refused in production unless `allowSimulation` is on. Media is
never a static mount: the session directory is its sibling, and the next
person to serve a directory of files should not be able to reach a WhatsApp
login by doing so.
