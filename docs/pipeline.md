# The pipeline

From a stored message to an item, and what each step costs.

## The tick

`scheduler.ts` runs every `PIPELINE_TICK_MS` (default 10s) and does three
things in order: cut bundles that are due, process outstanding bundles, send
queued deliveries. It is re-entrant-guarded, so a slow model call cannot
overlap the next tick. Bundles are processed **serially** — model calls never
stampede.

The tick also picks up bundles left `FILTERING` or `ANALYZING` by a crash or
an earlier failure, which is how a run that failed for a missing API key
completes by itself once a key is added.

## Cutting a bundle

Messages are judged in batches so a burst of short lines reads as one thought.
"boss" / "report sales tu boleh tak tambah filter ikut branch" / "finance team
nak export excel sekali" is one request typed in three bursts, and judging
each line alone gets it wrong.

A bundle is cut for a chat when any of these is true:

| Trigger | Meaning | Default |
|---|---|---|
| `quiet` | the chat stopped talking | 60s |
| `size` | enough is waiting | 15 messages |
| `age` | the oldest has waited too long | 300s |
| `manual` | **Run now** | — |
| `rescue` | one rescued message, straight to analysis | — |

Cutting is a transaction: the bundle row is created and the pending messages
are stamped with its id together, so two ticks cannot claim the same message.

## Reading the media

`lib/llm/media.ts`, run on the batch before the filter. Every message whose
`mediaTextStatus` is `PENDING` (set at ingest for JPEG/PNG/GIF/WebP images and
any `audio/*`) is read once:

| Kind | Call | Model | Stored |
|---|---|---|---|
| AUDIO | `callTranscribe` — OpenRouter `input_audio`, strict JSON `{transcript, language, unintelligible}` | `transcribeModel` (OpenRouter id; Claude takes no audio) | the transcript, verbatim in the language spoken |
| IMAGE | `callParsed` kind `MEDIA` with the image attached, `{description, textInImage}` | the filter model | description, then `Text in the image: …` |

The result lands in `mediaText` / `mediaTextStatus` / `mediaTextModel`; a
failure lands in `mediaTextError` and the message stays in the bundle. The
transcript line (`prompts.ts` `messageBody`) then reads
`[voice note, transcribed] …` or `[image — …] Caption: …`, or says why it
could not be read. Switching a reading off in Settings leaves the message
`PENDING`, so switching it back on and pressing **Read again** picks it up.
`POST /api/messages/:id/read-media` is that button. Calls are recorded in
`llm_calls` as kind `MEDIA` and priced like the rest.

## Whose side

`lib/team.ts` keeps the roster in memory. At ingest a message from a team
member is stored `SKIPPED` / "Sent by our team", exactly like `fromMe`; in
`prompts.ts` `senderLabel` appends `[our team]`; both system prompts say a
team member's words are context and commitments, never requests. The chat
description remains the place to say anything subtler ("Sharon is the
client's accountant").

## First pass — the filter

Cheap model. One decision per message: could this be part of something a rule
asks for?

It sees the chat's context (name, client, description, business name), the
active rules with their sender scopes, up to `contextMessages` earlier
messages for context, and up to 12 recent operator corrections as examples of
what matters and what does not in *this* chat.

Instructions that matter:

- Judge the meaning, not the language. Malay, English, Chinese, or a mix.
- Most messages are noise: greetings, "ok", "noted", thanks, stickers.
- Short follow-ups count. "dah siap ke?" after a request is part of it.
- Messages from us are context only, never flagged.
- **When unsure, flag.** A missed complaint costs far more than a false alarm,
  and the second pass double-checks.

A message the model forgets to decide on is **flagged with a reason saying
so**. The default has to be the safe side.

Cost control lives here: this is the only model that sees everything.

## Second pass — the analysis

Capable model, only on flagged messages. It receives the exact originals, the
filter's reason for each, the chat context, the rules, and the items already
open for that chat.

It returns a list of actions, and **every flagged id must appear in exactly
one**:

| Action | When | Effect |
|---|---|---|
| `create` | a new issue | one item from all the messages about it |
| `attach` | it is about an open item | linked as `STATUS_CHECK`, `DETAIL` or `FOLLOW_UP`, with a note |
| `ignore` | not actionable after all | dismissed, with the reason recorded |

Anything the analysis fails to mention is dismissed visibly rather than lost.
An item that was `DONE` or `DISMISSED` and gets a follow-up is **reopened** —
a closed item the client is still asking about is not closed.

A created item carries a title, a brief in plain words, suggested next steps,
a priority, the rules it satisfies, and any labelled fields the rule's "also
produce" asked for. All in the operator's chosen output language, whatever the
messages were written in.

Images are attached when `analyzeImages` is on: a screenshot is usually the
bug report, and the caption is usually "ni".

## Short ids

Inside the prompts, messages are `m1…mN`, rules `r1…rN`, items `i1…iN`.
Cheaper than uuids, and a model cannot mangle a uuid it never sees. They are
translated back on the way out, and anything referring to an id that does not
exist is dropped rather than trusted.

## Structured output, and why it is re-validated

Both passes use structured outputs — the Anthropic SDK's `messages.parse` with
a Zod schema, or OpenRouter's strict `json_schema`.

Neither is trusted. The reply is re-validated with Zod on our side, and the
first line of the raw reply goes into the failure message. "Invalid
discriminator" with no sample leaves you guessing between schema, prompt and
routing; the model's actual words answer it instantly.

On OpenRouter the schema is a *hint* enforced by whichever provider it routes
to, so the request names the validating providers first
(`Anthropic`, `Amazon Bedrock`, `Google Vertex`) and allows fallbacks.

## Learning

Two corrections feed back, both per chat and both immediately reversible from
the Review screen:

- **Rescue** a dismissed message → recorded as `RESCUED`, shown to the filter
  as an example of what matters. The message goes straight to analysis in a
  bundle of its own.
- **Dismiss** an item → its origin messages are recorded as `FALSE_POSITIVE`,
  shown as examples of noise.

The twelve most recent per chat are included in the filter prompt. This is
few-shot, not fine-tuning: honest about what it is, free, and undoable.

## Delivery

Items whose matching rules name WhatsApp numbers get a `Delivery` row per
distinct number. The scheduler sends up to 20 per tick with a 400ms gap — a
burst from a linked device reads as spam.

A send that fails increments `attempts` and records the reason; after five it
is `FAILED` with an event on the item. One failure usually means the link is
down, so the rest wait for the next tick rather than burning their attempts.

`sendText` throws when the socket is not open. There is no queue-and-hope and
no fallback to the mock.

## Cost

Every call writes an `LlmCall` row: kind, model, input/output/cache tokens,
latency, ok, error. Prices live in `llm/models.ts` and the dashboard turns
them into money over 7 and 30 days; Review shows per-run tokens and latency.

The economics only work because of the split. On a busy account the filter
sees everything and the analysis sees a few percent of it — which is the whole
reason for two passes rather than one good one.
