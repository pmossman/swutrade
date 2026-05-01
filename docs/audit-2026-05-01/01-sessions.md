# Sessions subsystem audit

Files: `lib/sessions.ts` (2572), `SessionView.tsx` (1327), `SessionTimelinePanel.tsx` (497), `SessionSuggestComposer.tsx` (249), `SessionSuggestions.tsx` (384), `useSession.ts` (575), `api/sessions.ts` (859).

## High-impact findings

### 1. `lib/sessions.ts` is 2.5k LOC of 7 distinct concerns
- **What:** Ghost minting, code generation, viewer rehydration, lifecycle, ghost-merge, proposal-promotion, Discord invite, chat + read-state, suggestions, revert — all one file. Section markers already exist at lines 1725, 1836, 2462.
- **Where:** `lib/sessions.ts:1-2572`.
- **Why it matters:** Every contributor pulls it all into their head. Auth agent overlaps on `mergeGhostIntoRealUser` (1276); discord agent on `inviteHandleToSession` (1581).
- **Proposed fix:** Split per markers into `lib/sessions/{core,ghost,events,suggestions,invite,chat}.ts`; barrel re-export keeps api/sessions.ts imports stable.
- **Risk:** low. **Effort:** M. **Confidence:** high.

### 2. Every mutation re-fetches the full session view (4-5 sequential queries)
- **What:** `editSessionSide`, `confirmSession`, `unconfirm`, `cancel`, `claim`, `acceptSuggestion`, `dismiss`, `suggest`, `sendChatMessage`, `markRead`, `proposeRevert` all do `update(...)` then `await getSessionForViewer(...)` — which fans out to session SELECT + counterpart SELECT + 50-row events + full unread scan. `getSessionForViewer` is referenced 19× here.
- **Where:** `lib/sessions.ts:1068, 1140, 1203, 1248, 949, 2403, 2196, 2238, 2457, 2565`; orchestrator `:233-315`.
- **Why it matters:** Fluid Compute bills wallclock; the 2.5s poll (`useSession.ts:193`) doubles load. `mutationInFlightRef` (line 221) hides symptom, not work.
- **Proposed fix:** Drizzle `.returning()` on UPDATE; mutations return only changed deltas. At minimum `Promise.all` the two reads inside `getSessionForViewer`.
- **Risk:** medium. **Effort:** M. **Confidence:** high.

### 3. `SessionView.tsx` is a 1327-LOC god component, 14 inner subcomponents
- **What:** SessionView itself is 530 lines; file holds 13 more subcomponents (SplitViewToggle, IdentityStrip, TimelineToggle, TerminalBanner, ActionBar, CommitmentStrip, Badge, ConfirmBadge, CounterpartAvatar, GhostSignInBanner, InvitePrompt, OpenSlotInvite, InviteByHandleForm). Active-session render is wrapped in an IIFE at line 293.
- **Where:** `src/components/SessionView.tsx:48-577`.
- **Why it matters:** IIFE prevents memoization across the poll — TradeSide × 2 + TradeBalance + suggestion lists re-render every 2.5s on idle tabs.
- **Proposed fix:** Extract `SessionCanvas` (293-539) and `OpenSlotPanel` to siblings; replace IIFE with early-return; move trivial chrome to `ui/`.
- **Risk:** low. **Effort:** M. **Confidence:** high.

### 4. JSONB `pendingSuggestions` has lost-update races
- **What:** `suggestForSession`, `acceptSuggestion`, `dismissSuggestion`, `editSessionSide` auto-sweep, `proposeRevertForSession` all read-modify-write the JSONB without optimistic concurrency. Concurrent suggests or edit+suggest = last-write-wins.
- **Where:** `lib/sessions.ts:2117-2224, 2258-2359, 2422-2448, 1011-1026`.
- **Why it matters:** Cross-device flows + 2.5s poll make races realistic. Silent UX bug.
- **Proposed fix:** Add `revision` int column, bump on each mutation, gate updates on it; retry once.
- **Risk:** medium (schema). **Effort:** M-L. **Confidence:** medium-high.

### 5. `useSession` mutation callbacks invalidate every poll
- **What:** 11 callbacks have `[sessionId, session, ...]` deps. Each `applyServerSession` makes `session` a fresh ref → `saveCards` invalidates → SessionView's `handleAdd`/`handleRemove`/`handleChangeQty` (171-198) invalidate → TradeSide re-renders. Cascade fires every 2.5s on idle data.
- **Where:** `src/hooks/useSession.ts:326, 364, 379, 393, 407, 429, 487, 511, 526, 541`.
- **Proposed fix:** Read session from `latestRef.current` in `saveCards`; drop from deps. Short-circuit `setSession` on identical snapshots.
- **Risk:** low. **Effort:** S. **Confidence:** high.

## Lower-priority debt

- `getSessionForViewer` vs `listActiveSessionsForViewer` duplicate rehydration (`:266-314` vs `:499-544`); extract `rehydrateRow()`.
- Ad-hoc `as` casts on JSONB payloads at `:664, 671, 1661, 2510`; need typed payload readers keyed on `event.type`.
- Five hand-rolled try/catch+log at lines 594, 738, 1342, 1702, 1523 — a `bestEffort(label, fn)` helper would dedupe.
- `EventRow` (`SessionTimelinePanel.tsx:252-336`) reads 9 payload fields with bare typeof/isArray — same reader opportunity.
- `hasUnseenCounterpartEdit` (`useSession.ts:317-320`) compares ISO strings lexicographically; use `Date.parse`.
- `SessionView.tsx:115-123` `lockedProductIds` memo deps on `session?.suggestions ?? []` — new array per render busts memo.
- `SessionView.tsx:150-152` uses `useMemo` for ref-assignment side-effect.
- `useSession.ts:308-315` initial-seen pointer is render-order-coupled; move to `fetchOnce` success branch.
- `SessionTimelinePanel` visualViewport tracking (`:133-145`) duplicated elsewhere — extract `useVisualViewportHeight()`.
- `(viewerIsA ? 'a' : 'b') as 'a' | 'b'` at `:507` — TS should narrow.
- Tests `sessions-write.test.ts` (397), `sessions-suggest.test.ts` (448) large but low-mock real-DB via `describeWithDb`; size-only flag.

## Anti-recommendations

- **Don't split `lib/sessions.ts` by lifecycle stage.** Every mutation touches read (refetch); splitting that way duplicates type imports and forces circular gymnastics. Split by domain seam per PR markers.
- **Don't memoize trivial subcomponents (`Badge`, `ConfirmBadge`, `LockIcon`, `CounterpartAvatar`).** Equality-check costs more than re-render for 4-line pure components.
- **Don't replace JSONB `pendingSuggestions` with a child table.** Every read becomes a JOIN; cap-of-10 is app-side anyway; auto-dismiss-then-prune gets harder with FKs; ghost-merge gains a third table. Fix concurrency with optimistic locking, not normalization.
- **Don't collapse `recordOrMergeEditedPair` into "always insert".** The 30s merge window (line 1861) + paired snapshots drive timeline readability AND the revert UI.
- **Don't `await` event-log writes** — fire-and-forget is intentional (572-602); audit-log loss is correctness-neutral. Awaiting would let event hiccups roll back state.
- **Don't refactor `targetSide: 'a' | 'b' | 'both'` into separate suggestion types.** `acceptSuggestion` (2284-2342) wants all three branches in one function for shared cap/lock/merge checks.
- **Don't replace the 2.5s poll with SSE/WebSockets.** SSE doubles function-count budget; the 12-function Hobby cap is already constrained. Polling is the right primitive here.
