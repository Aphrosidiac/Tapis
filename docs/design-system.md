# Design system

The SmoothSail / RackForge system, unchanged in structure so the three read as
one house: an ink ramp on a near-white ground, hairline borders carrying a soft
shadow, 6/10/14 radii, 15px body. Tapis keeps its own teal accent and its own
typeface.

Tokens live in `frontend/src/main.css`. No view names a colour directly.

## Colour

| Token | Hex | Use |
|---|---|---|
| `ink-900` | `#0f1b21` | headings |
| `ink-800` | `#1b2a32` | body |
| `ink-600` | `#40575f` | secondary |
| `ink-500` | `#5c7480` | muted text, nav links — 4.9:1, the floor for text |
| `ink-400` | `#93a7b1` | **icons and disabled only** — 2.5:1, never text |
| `ink-300` | `#c3d0d6` | placeholders |
| `line-200` / `line-100` | `#e1e9ec` / `#edf2f4` | borders, dividers, card edges |
| `surface-50` / `surface-0` | `#f7f9fa` / `#ffffff` | page, cards |
| `primary-700` | `#0b6e63` | links, active nav — 6.1:1 |
| `primary-600` | `#0f8b7e` | the mark, toggles, focus ring |
| `success/warning/info/danger-600` | | status, each with a `-50` fill |
| `violet-600` | `#6552c8` | the second status axis |

**The primary action is ink, not the accent.** White on `primary-600` measures
4.2:1 and fails AA for a 15px label. The accent stays where it is a signal
rather than a surface.

**Two status axes, deliberately not sharing colours.** An item's progress
(new → in progress → done) and a message's fate (dismissed, flagged,
attached) are different questions. Sharing the semantic five is how "New" and
"Flagged" end up as the same amber pill, so the message axis gets violet.

## Type

**Manrope**, self-hosted. Deliberately not the Hanken Grotesk the siblings
use.

Chosen by rendering the real screens under six candidates rather than reading
specimens. All six carried a `tnum` feature; **Schibsted Grotesk and Onest
apply it to punctuation as well as digits**, so `RM 12,480.50 · 09:42` came
out as `RM 12 , 480 . 50 · 09 : 42`. Disqualifying for a UI full of money and
timestamps, and invisible in a feature table.

The stack carries CJK fallbacks — `PingFang SC`, `Hiragino Sans GB`,
`Microsoft YaHei`, `Noto Sans SC`. Clients write in Chinese and no Latin
variable font covers a single one of those glyphs.

| Role | Size / line / weight |
|---|---|
| Page title | 20 / 28 / 600, −0.01em |
| Card title | 16 / 24 / 600 |
| Body | 15 / 22 / 400 |
| Label, small body | 14 / 20 |
| Caption | 13 / 18 |
| Eyebrow, table header | 12 / 16 / 600 uppercase, 0.08em |

Money and counts take `.num` (`tabular-nums`) so columns align.

## Components

`.card` (border **and** shadow — the border does the work, the shadow lifts it
off the ground), `.field`, `.eyebrow`, `.num`, `.original`, `.skeleton`,
`.no-bar`.

`components/base/`: BaseButton, BaseInput, BaseTextarea, BaseSelect,
BaseToggle, BaseBadge, BaseModal, Card, Alert, StatCard, EmptyState,
PageHeader, ToastContainer.

`.original` is the one that matters for correctness: `pre-wrap` plus
`overflow-wrap: anywhere`, because a client's message can be a 400-character
URL and it must wrap rather than widen the column it sits in.

## The dashboard is triage, not metrics

It opened on six tiles — open items, done, tracked chats, waiting to be read,
dismissed as noise, model cost. All true; none of them a decision. Two were
already visible in the tab counts directly below.

The test for a tile: **if this number doubled, what would I do differently
today?** No answer means it is a line of small text at the bottom, not a box
at the top.

It now asks three questions, each a filter you can click:

- **Chasing you** — an open item the client has come back to ask about. The
  highest-signal event the product has, and nothing else surfaced it.
- **Left sitting** — open, untouched over 48 hours, showing the worst age.
- **Urgent & high** — open, at those priorities.

A check with nothing in it gets no card, only a one-line "Also clear"; when
all three are clear the block collapses to a single line. Three boxes where
two say Nothing fill a phone screen with the absence of news — removing them
took the mobile dashboard from 1204px to 844px, exactly one screen.

The same signal repeats at three zoom levels: the card, the client group
header (`chasing`, `oldest 14h`), and the row (`chased 3 h ago`).

## Notices belong to the app, not a page

Warnings used to be banners on the dashboard, which meant a dead WhatsApp link
was invisible from every other screen — including Chats, where you would be
wondering why nothing had arrived. They are a bell with a count in the header,
fed by `/api/notices`.

Two traps in that popover, both worth remembering:

- Anchored to the bell with `absolute right-0`, it ran off the **left** edge
  of a 390px screen. Pin popovers to the viewport, not the trigger.
- It cannot be `position: fixed` inside the header: the header carries a
  `backdrop-blur`, and a filtered ancestor becomes the containing block for
  fixed descendants, so it stayed trapped in a 64px bar. It is teleported to
  `<body>` — which then means click-outside must test the trigger **and** the
  panel, since the panel is no longer a descendant of the component.

## Verifying mobile

**Neither browser on this Mac can be made phone-width by hand.** The in-app
pane floors at ~522 CSS px; Chrome's own window at ~544. Immediately after a
resize `window.innerWidth` also keeps returning the old value while the
screenshot shows the new one, so a reading taken then describes neither.

Use Playwright with a device descriptor (`devices['iPhone 13']`, 390×844,
touch). Two things that made the first audit lie:

- A **full-page screenshot resizes the viewport** and does not always restore
  it — three of eight pages were measured at 441 and 523px. Re-pin and assert
  the width before every measurement.
- `elementFromPoint` returns `null` for anything outside the viewport, so
  off-screen controls read as unhittable. Scroll each into view before
  probing.

What the audit checks: horizontal overflow (ignoring the children of
intentional scrollers, which are *supposed* to hang past the edge), clipped
text, targets under 40px, text under 12px, and fields under 16px — anything
smaller makes iOS Safari zoom the page on focus and leave it zoomed.

### Touch targets

`min-height` alone is not enough, and measuring is what showed it: every
icon-only control was 28–36px **wide** and 42 tall — a target you miss
sideways. Both dimensions have a floor under `pointer: coarse`.

A switch is the exception. Its track *is* the button, so a `min-width` would
stretch the track and leave the knob travelling the wrong distance. It gets an
invisible `::after` hit area instead, which grows the target without touching
a painted pixel — and which `getBoundingClientRect` cannot see, so verify it
by hit-testing rather than by measuring the box.

### Other mobile rules

Dialogs are bottom sheets below `sm`. The toast stack, drawer footer and sheet
footer respect `env(safe-area-inset-bottom)`, and the viewport meta opts in
with `viewport-fit=cover`. Chat detail shows Messages first on a phone: the
configuration above it is set once, the messages are why anyone opens it
there.

## Motion

`rise` on page bodies (240ms), 120ms on hover and colour, 180ms on menus and
toasts, 260ms on dialogs. Only opacity and transform. Everything collapses to
0.01ms under `prefers-reduced-motion` — not to zero, so `transitionend` still
fires and nothing waits forever on a callback that never comes.
