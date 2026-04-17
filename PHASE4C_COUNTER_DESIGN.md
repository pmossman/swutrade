# Counter-proposal flow — design

Living doc. Drafted during Phase 4c so related features (trade
history, detail view, cancel, expiry) can be architected with the
counter flow in mind, even if the counter slice ships later.

Not yet implemented. Ratify this before coding.

## Semantics

A **counter** is "I can't accept your proposal as-is, but here's what
I'd accept instead." Mechanically it's two actions rolled into one:

1. The original proposal is **closed** (recipient chose not to accept
   it, but softer than Decline — the door stays open on a modified
   version).
2. A **new proposal** is created in the opposite direction — the
   former recipient becomes the proposer, with an edited trade.

The key model decision: the counter is **not a mutation** of the
original. It's a sibling linked by a self-FK. This keeps history
clean (you can always see what was proposed and what was countered
with), avoids concurrency races on a single row, and lets the
chain extend naturally (counters can counter counters).

## Schema change

One new nullable column on `trade_proposals` + one new status value:

```ts
counterOfId: text('counter_of_id').references(
  (): AnyPgColumn => tradeProposals.id,
  { onDelete: 'set null' }
),

// status enum extended:
//   'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'countered'
```

- `counter_of_id`: when set, points to the proposal this counter
  was made against. A chain is a linked list walked backwards.
- `'countered'`: terminal state for the original when a counter
  is created. Cannot transition further.
- `on delete set null`: if the original is somehow deleted (user
  cascade), the counter survives as a standalone proposal with
  an orphaned history pointer, which is fine.

No migration cost on existing rows — `counterOfId` starts null.

## UX

### Recipient's DM gets a third button

Current: `[Accept] [Decline]`
After: `[Accept] [Counter] [Decline]`

Counter button style: neutral (grey, style 2 SECONDARY) to
distinguish from success-green Accept and danger-red Decline.

### Clicking Counter in Discord

Discord bots can't render a composer inside a DM. So the button's
interaction response is a **deep-link** back to the web app:

```
type: 4 CHANNEL_MESSAGE_WITH_SOURCE
data: {
  content: "Open SWUTrade to compose your counter: https://beta.swutrade.com/?counter=<tradeId>",
  flags: 64 // ephemeral
}
```

The original DM is also edited to strip buttons + append a status
line "Countering… (open the web to finish)", so the recipient
can't re-click mid-compose.

The server does NOT transition status to `'countered'` yet — only
after the counter is actually submitted. Until then, status stays
`pending` so the recipient can change their mind and come back to
Accept/Decline via a separate path. (Open question: should clicking
Counter eagerly lock the original into a new `'countering'`
intermediate state? Probably overkill for v1.)

### Web composer at `/?counter=<tradeId>`

Variant of the existing ProposeView (same TradeSide components),
seeded from the original proposal's cards but with sides flipped:

- Original `offeringCards` → pre-fill the counter's **Receiving**
  side ("what I want from them")
- Original `receivingCards` → pre-fill the counter's **Offering**
  side ("what I'll give them")

The user edits freely and clicks **Send counter**. New component:
`CounterBar` (or a `mode` prop on ProposeBar). Same note affordance
as ProposeBar. A small "In response to @X's proposal" chip in the
bar header gives context.

Authorization: the viewer's user id must match the original
proposal's `recipient_user_id`, else 403. Non-recipients landing
on `/?counter=<id>` see an error.

### Submit → new proposal + state transitions

`POST /api/trades/counter` (new action):
1. Look up original by id; verify status is `pending` + viewer is
   the recipient.
2. Insert a new `trade_proposals` row with:
   - `proposer_user_id` = original.recipient
   - `recipient_user_id` = original.proposer
   - `counter_of_id` = original.id
   - `status` = 'pending'
   - cards + message from the request body
3. Update original: `status` = 'countered', `responded_at` = now.
4. Edit the original's DM in place (using stored
   `discord_dm_message_id`) to show the countered status + strip
   buttons.
5. DM the original proposer with the counter. Same embed shape as
   a fresh proposal — focused on what's being proposed NOW, not
   the full history. One extra "Counter to your earlier proposal"
   sub-header gives enough context; deep history lives in the web
   detail view. Accept/Counter/Decline buttons on THIS DM carry
   the new trade id, so the chain continues.

   Rationale: Discord DMs are a notification surface, not a
   browser. If we tried to render two, three, or ten levels of
   history in one embed, we'd hit the 4096-char description cap
   AND overwhelm the reader on mobile. Principle: **each DM shows
   the single decision point in front of you.** The web app's
   trade detail view owns chain visualization.

### Chain termination

Counters are recursive — counter-of-counter-of-… is structurally
fine. Terminal states for any proposal in the chain:

- `accepted` — both parties agreed at this node. Done.
- `declined` — recipient said no, no counter. Chain dies.
- `cancelled` — proposer (of that specific node) retracted.
- `expired` — TTL hit (Phase 4d candidate).
- `countered` — recipient produced a new node; this one closes
  but the chain continues on the child node.

Any terminal state other than `countered` is a leaf.

## Impact on related features

### Trade detail view (`/?trade=<id>`)

Should render a **chain view** when `counter_of_id` is set on the
viewed trade or any ancestor. Walk backwards via FK, render
timeline-style: original → counter1 → counter2 → (current).

Each row shows who proposed, what was offered/asked, status + when
it transitioned. Viewer's own rows get "you" labels; the other
party's get the handle.

### Trade history (`/?trades=1`)

A single chain should collapse to one row per "conversation" (by
walking FKs to find the root). Show the root + summary ("last
activity: counter sent 3h ago"). Opening the row navigates to the
detail view showing the full chain.

### Cancel by proposer

Only the proposer of a `pending` proposal can cancel. Transitions
to `cancelled`. Edits the recipient's DM to strip buttons + show
"Cancelled by proposer". Does NOT cancel ancestors in the chain
(those already resolved to `countered` when this one was created).

### Expiry (future)

A daily cron sets `status` = 'expired' on `pending` proposals
older than N days (30?). Edits the recipient's DM to strip
buttons + show "Expired". Same rule: expiring a node doesn't
touch ancestors.

## Open questions

- **Max chain depth?** Technically unbounded. Practically we might
  want a soft cap (e.g., 10 levels) to prevent ping-pong. Monitor
  in production, add a limit if needed.
- **Can the proposer preemptively offer multiple alternatives?**
  (e.g., "here's option A or option B"). Out of scope for v1; would
  need a different data model.
- **Does the web app need to show "someone countered you" even if
  the bot DM failed to deliver?** Probably yes, but the trade
  history view handles this naturally — a new pending proposal
  from X to you shows up in the Inbox. No extra wiring needed if
  history/inbox land first.

## Scope for implementation slice

Slice 4 (minimum viable counter):

- Schema change + migration
- `/api/trades/counter` POST endpoint + 8-ish integration tests
- Extend bot interaction handler: Counter button added to DMs,
  custom_id `trade-proposal:{id}:counter` returns the deep-link
  ephemeral, no state change yet
- ProposeBar variant / new CounterBar at `/?counter=<id>`
- Original's DM gets edited on submit (reuse
  `buildResolvedProposalMessage` with a new outcome variant)
- E2E: original proposer sends → recipient counters via web
  composer → original proposer receives counter DM (synthetic
  signed click on Counter button shows deep-link)

Non-goals for slice 4:
- Trade history view (separate slice)
- Chain visualization (separate slice)
- Cancel by proposer (separate slice, cheap addition after)
- Expiry cron (Phase 4d)

## Risks / things to sanity-check before starting

- **Race: proposer accepts while recipient is composing a counter**.
  The counter endpoint must re-check `status === 'pending'` at
  submit time. If the proposer-side has a cancel button in the UI,
  same guard applies there.
- **The deep-link pattern requires the recipient to be signed into
  SWUTrade on the web.** If they aren't, `/?counter=<id>` needs a
  "sign in to continue" prompt that preserves the target URL.
  Already covered by the existing sign-in flow, but verify.
