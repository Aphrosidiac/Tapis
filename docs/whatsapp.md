# The WhatsApp channel

Tapis reads WhatsApp as a **linked device** on an ordinary account, over the
same multi-device protocol WhatsApp Web uses, through
[baileys](https://github.com/WhiskeySockets/Baileys) pinned at `6.7.24`
(npm tag `legacy`; `latest` is a 7.x release candidate).

No Meta review and no number registration. In exchange: no delivery
guarantees, no template messages, and a session the phone can revoke at any
moment.

Everything here was learned against real accounts. Each section says how the
failure presented, because every one of them looked like nothing at all.

---

## The failure this module is built around

A linked device does not break loudly. The phone unlinks, the websocket dies,
the process keeps answering health checks, and nobody notices until a client
complains days later. A sibling project lost weeks of dispatch that way with
PM2 green the whole time.

So:

- **One state per real situation.** `off`, `unlinked`, `starting`, `pairing`,
  `connected`, `reconnecting`, `logged-out`, `failed`. The last three need a
  person; a status stuck on "reconnecting" forever hides that.
- **Liveness is `sock.ws.isOpen`, never the last event received.**
  `state === 'connected'` is a memory of an event. A 30s watchdog compares the
  two and forces a reconnect when they disagree; the status reports both so
  the disagreement is visible rather than reconciled away.
- **Sending while not connected throws.** It never silently succeeds and never
  quietly falls back to a mock. A message the operator believes was delivered
  is the worst outcome available.
- **The keys are never deleted by a disconnect code.** Only `Unlink`, or
  linking again after a confirmed logout, removes `.wa-session`. The codes
  that look terminal are not proof: Baileys reports **500 `badSession`** for
  *any* stream error it cannot name, WhatsApp sends **401 `loggedOut`** both
  when the phone removed the device and to a socket that raced a dying one on
  the same keys (every `tsx watch` restart), and **440 `connectionReplaced`**
  is usually the connection we just closed still counting as alive. So 500 is
  an ordinary retry, a 401 is retried once before it is believed, and a 440
  is retried twice before the link is declared taken. Only `forbidden` stops
  on the first sight. Ordinary drops get exponential backoff, capped at a
  minute.
- **`markOnlineOnConnect: false`.** Marking the account online takes push
  notifications away from the human phone, so staff stop seeing client
  messages on their own device.
- **Only one process may hold a session.** Two processes on one session
  directory knock each other offline in a loop.
- The session directory is never under anything served statically. It holds a
  complete WhatsApp login.

---

## Trap 1 — `@lid` addressing drops every message

WhatsApp now addresses one-to-one chats two ways. The old form is the phone
number, `60123456789@s.whatsapp.net`. The newer **LID** form is an opaque
per-account id, `80943691858039@lid`, which carries the real number beside it
in `key.senderPn` — *sometimes*.

The obvious guard:

```ts
if (!jid.endsWith('@s.whatsapp.net')) return null   // wrong
```

refuses **every** message from a LID-addressed handset. The socket stays
genuinely healthy, so the watchdog cannot see it and neither can `ws.isOpen`.
Messages confirmed delivered on the phone reach nothing.

Whether a number is attached is not a property of the message — it is a
property of whether that contact happens to be resolvable. Some numbers
deliver a second PN-addressed copy of everything; some never do.

**What Tapis does**

- Accept a LID with a number (`senderPn`, `participantPn`) and key the person
  on the **number**.
- Accept a LID with no number and key on `lid:<digits>` — a prefix that cannot
  be mistaken for a phone number by anything downstream. `isUsableWaId`
  rejects it, so matching-by-phone-tail is skipped rather than matching a
  stranger on nine coincidental digits.
- Send back to `@lid` for those. Stripping a LID to digits and appending
  `@s.whatsapp.net` produces a syntactically perfect address for **somebody
  else**.
- Group messages take the sender from `key.participant`, which may itself be a
  LID, with the number in `participantPn`.
- **Log every declined inbound with its jid and reason.** A message that
  reaches the socket and vanishes with no trace is indistinguishable from one
  that never arrived. That is what made this expensive.

No test caught this elsewhere because every fake socket emitted
`@s.whatsapp.net`. **A suite that authors its own input format cannot discover
the format reality uses.**

---

## Trap 2 — `syncFullHistory: false` switches off the whole history sync

Symptom on the first real account: **199 chats, 197 of them groups, 196
reading "never", every contact a bare number, and no one-to-one chats at all.**

`makeWASocket` fills in a default you never wrote:

```js
shouldSyncHistoryMessage = () => !!syncFullHistory
```

So `syncFullHistory: false`, set to avoid pulling years of messages, also
answers **false for `INITIAL_BOOTSTRAP` and `RECENT`**. Baileys logs
`History sync skipped` and never emits `messaging-history.set` — the only
event carrying the chat list, each chat's last-message time, and every
one-to-one chat. What is left is `groupFetchAllParticipating()`, which returns
groups and **no timestamps at all**, so any "sort by most recent" sorts a
column that is null.

It costs the app-state sync too: `doAppStateSync` only runs once the socket
reaches the `Syncing` state, and only the history path enters it. That is why
the contacts had no names.

Keep both options. They are not the same question:

```ts
syncFullHistory: false,               // do not ask for the archive
shouldSyncHistoryMessage: () => true, // but do process what arrives
```

**The initial sync only happens at pairing.** A reconnect, a process restart,
or a `resumeOnly` start will not replay it. An account linked before this fix
keeps its thin list until it is unlinked and linked again.

---

## Trap 3 — the chats in that sync carry no timestamp

With the sync finally arriving, every chat *still* read "never".

Measured on a real RECENT sync: **905 chats and 58,293 messages across
eight chunks, and not one chat record carried a `conversationTimestamp`.**
Baileys builds those chat records from the conversation, and for a one-to-one
chat the field is simply absent.

The times are on the **messages**, which the handler was discarding. So:

- Derive the last-message time per jid from `payload.messages`
  (`key.remoteJid` + `messageTimestamp`), newest wins.
- Treat `conversationTimestamp` as a bonus when present.
- Any jid seen only on a message still becomes a chat — the messages are the
  only place the one-to-one conversations appear.

Decoding those timestamps needs care of its own. A protobuf Long arrives as
`{low, high}`, as a string, or as a plain number depending on the field and
which codec path decoded it. `Number(v?.low ?? v ?? 0)` looks right, silently
answers **0** for the shapes it does not match, and truncates a genuinely
64-bit value to 1970. `waSeconds()` handles all four, and is tested against
all four.

The sync arrives in chunks with `progress` and `isLatest`. Apply each chunk as
it lands; do not wait for completion, and do not restart the process
mid-sync — it will not replay.

---

## Trap 4 — the address book arrives before the chats it names

With history working, 905 chats landed and 859 had real times. Every private
chat was still a bare `+60…`.

Saved contact names do not come in the history sync at all. They come through
the **app-state sync**, as `contactAction` mutations surfaced as
`contacts.upsert` with `name: fullName`. That sync runs immediately after
pairing — **before the history sync has created a single chat**. A handler
that applies a name only to a chat that already exists therefore discards the
entire address book, silently and without error.

**What Tapis does**

- Contacts get their own `Contact` table, written the moment they arrive
  whether or not a chat exists.
- `discoverChat` consults it when naming a private chat. A saved name beats
  the chat record's own: WhatsApp shows you the name *you* gave someone.
- A contact never becomes a chat row. Most of an address book has never been
  messaged — on the real account, 320 of 535 contacts had no conversation.

### Recovering names without re-pairing

`resyncAppState` asks WhatsApp for a full snapshot **only when it holds no
version** for a collection:

```js
return_snapshot: (!state.version).toString()
```

After a completed pairing it therefore returns the patches *since* that
version, which is nothing. Clear the stored versions first:

```ts
await sock.authState.keys.set({
  'app-state-sync-version': { critical_unblock_low: null, regular_low: null, regular_high: null },
})
await sock.resyncAppState(['critical_unblock_low', 'regular_low', 'regular_high'], true)
```

Measured on the live account: **535 contacts recovered, 215 chats renamed, no
QR scan.** Exposed as *Resync contact names* on the Chats screen, because the
names are the difference between a usable chat list and a page of numbers.

---

## What can never appear

By design, and worth saying out loud when someone asks why a chat is missing:

- **Status updates** (`status@broadcast`), **Channels** (`@newsletter`) and
  **broadcast lists** (`@broadcast`). None is a conversation with a client.
- **Reactions**, protocol messages and key-exchange traffic.
- Any chat that neither spoke inside the synced history nor is a group the
  account is currently in — there is no source for it.
- A LID-addressed chat with no matching contact shows as
  `Unknown contact (429066)`. It is present and sorted correctly, but it
  cannot be found by name. WhatsApp shows unsaved numbers as numbers too.

---

## Discovering chats

Three sources, in order of completeness:

| Source | Gives | Missing |
|---|---|---|
| `messaging-history.set` | the chat list, one-to-one chats, last-message times, push names | only fires at pairing |
| app-state sync | saved contact names | runs before the chats exist |
| `groupFetchAllParticipating()` | every group currently joined, with member counts | no timestamps, no private chats |

Plus live traffic, which names and dates a chat the moment it speaks.

---

## Unlinking

`logout()` tells WhatsApp to drop the device **before** deleting the local
keys. Deleting alone leaves a ghost device listed on the phone, holding one of
the four slots WhatsApp allows, which nothing on the server can remove.

If the socket is down, it brings it up (bounded, 8s) to say the words. If it
truly cannot, it clears the keys anyway and raises a persistent notice naming
the only remedy: remove it on the phone.

A route sweep that POSTs to every endpoint will find this one. Elsewhere that
accumulated ghosts from ten test runs across two days before anyone noticed.
