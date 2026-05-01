# Refactor candidates — cross-cutting

## High-impact findings

### 1. Mutex bookkeeping inlined ~14× in `useSession`
- **What:** Every mutation in `useSession.ts` manually flips `mutationInFlightRef.current = true/false` around its `try/finally`, with the same early-return guard.
- **Where:** `src/hooks/useSession.ts:221`, `:231`, `:236`, plus 12 more pairs at `:328-553`.
- **Why it matters:** Bug-prone — if a new mutation forgets one half of the pair, the hook silently locks. Extracting collapses each mutation from 8 lines of refs/finally to 3.
- **Proposed fix:** Add a `withMutationLock(fn)` helper inside the hook (or `useMutationLock()` returning `{ run, isBusy }`). Replace each pair with `await run(async () => {...})`. Optimistic snapshot/rollback stays caller-side.
- **Risk:** low.  **Effort:** S.  **Confidence:** high.

### 2. Discord embed-builder bodies duplicated across 6+ proposal/thread variants
- **What:** Six builders in `lib/proposalMessages.ts` repeat the same `{ title, color, fields: [Offered, Asked-for, ...imbalance], footer }` skeleton with field-name and color swaps. `0x8B5CF6` is hand-coded twice (`:720`, `:803`) instead of joining `COLORS` (`:41`).
- **Where:** `lib/proposalMessages.ts:153-820`. Inline embed colors also at `tradeGuild.ts:433`, `api/bot.ts:2354`.
- **Why it matters:** 1117 LOC; field wording has already drifted — `buildProposalMessage` says "You would receive / give" but `buildThreadMovedProposalMessage` (`:724`) and `buildCounteredProposalMessage` (`:807`) still say "Offered / Asked for".
- **Proposed fix:** Extract `proposalCardFields(ctx)` and `proposalFooter(ctx)`. Add `purple` to `COLORS`, route every literal through it. Each builder becomes ~10 lines composing primitives.
- **Risk:** low.  **Effort:** S.  **Confidence:** high.

### 3. Three+ near-identical `timeAgo` and `Avatar` components
- **What:** `timeAgoShort` (`HomeView.tsx:1165`), `timeAgo` (`TradeDetailView.tsx:489`), `formatRelative` (`CommunityView.tsx:565`), `formatTerminalDate` (`SessionView.tsx:817`) all do "minutes/hours/days ago, then locale date". Three byte-identical `Avatar` at `HomeView.tsx:1177`, `SettingsView.tsx:1003`, `CommunityView.tsx:854`. Two `GuildAvatar` at `SettingsView.tsx:1018`, `CommunityView.tsx:869`. `CloseIcon`/`ChevronIcon`/`CheckIcon` repeat across 6+ files (33 inline `function *Icon` definitions).
- **Why it matters:** Bloats the three biggest UI files; restyling one Avatar means three diffs.
- **Proposed fix:** `src/components/ui/Avatar.tsx`, `GuildAvatar.tsx`, `icons.tsx`, and `src/utils/relativeTime.ts`. Net delete ~120 LOC.
- **Risk:** low.  **Effort:** S.  **Confidence:** high.

### 4. `lib/sessions.ts` (2572 LOC) needs a directory split
- **What:** 63 exports spanning views, lifecycle, chat+read-state (`:1725-1834`), suggestions (`:1836-2460`), revert (`:2462-end`), ghost-merge (`:1276-1409`). Author-marked `// PR 1`/`// PR 2`/`// PR 3` boundaries explicitly call out sub-modules.
- **Why it matters:** Largest non-bot file in lib/; agent #1 has to navigate the same wall.
- **Proposed fix:** `lib/sessions/` with `views.ts`, `lifecycle.ts`, `chat.ts`, `suggestions.ts`, `revert.ts`, `ghostMerge.ts`, `index.ts` re-exporting the public surface. Author's PR markers tell you the slice points.
- **Risk:** medium (large diff; barrel file keeps imports stable).  **Effort:** M.  **Confidence:** high.

### 5. `failure()` status mapping copied verbatim across `apiClient.ts` and `tradeActions.ts`
- **What:** `apiClient.ts:21-41` and `tradeActions.ts:33-47` both hand-roll the same status→reason switch. The comment in `apiClient.ts:13-16` claims tradeActions piggy-backs to avoid duplication, but it actually still has its own `post()` (`tradeActions.ts:49`) and `failure()`. `__mapFailureForTradeActions` re-export (`apiClient.ts:85`) is unused.
- **Why it matters:** Active drift risk; the comment lies.
- **Proposed fix:** Make `tradeActions.ts::post` call `apiPost`; delete local `failure()` + `post()` + the dead re-export.
- **Risk:** low.  **Effort:** XS.  **Confidence:** high.

## Lower-priority debt

- `restrictionKey` has 4 parallel implementations: `lib/shared.ts:6`, `src/hooks/useWants.ts:42`, and `restrictionKeyOf` at `ListCardPicker.tsx:156` and `SignalBuilderView.tsx:19`.
- `api/bot.ts` (2618 LOC) — section markers at `:106`, `:140`, `:246`, `:296`, `:484`, `:933`, `:1309`, `:1770`, `:2199` reveal split lines.
- `api/og.ts` (1212 LOC) — `renderCardGrid`/`renderListImage`/`renderListColumn`/`renderListRows`/`renderSignalImage` could each move to `api/og/render-*.ts`.
- `src/components/SessionView.tsx` (1327 LOC) — 21 inline sub-components; `SessionIdentityStrip`, `TerminalBanner`, `SessionActionBar`, `CommitmentStrip`, `InvitePrompt`, `OpenSlotInvite`, `InviteByHandleForm` are extraction candidates.
- 43 hand-rolled `res.status(405).json({ error: 'Method not allowed' })` calls + 38 `if (req.method !== 'X')` checks could fold into `requireMethod(req, res, 'POST')`. Borderline value.
- Per-view hash-route parsers (`SettingsView.tsx:237`, `CommunityView.tsx:216`) repeat a `parseRoute`/`buildUrl`/`parentRoute` shape with different route schemas — borderline `useHashRoute<T>()` candidate.
- 51 `console.error/warn` calls scattered outside the `errorReporter` pipeline — inventory item.

## Anti-recommendations

- **`lib/discordClient.ts` vs `lib/discordBot.ts`** look like a duplication but wrap different auth (user OAuth vs bot token) with different retry/idempotency models. Leave parallel.
- **Retry/backoff loop in `discordBot.ts:179-231`** is the only real one; other "retry" grep hits are user-driven, not loops. Don't generalize to a `withRetry` helper — the 429-vs-5xx-vs-idempotent decision is Discord-specific.
- **Optimistic-then-rollback shapes** in `useFavorites.ts:83` (idempotent absent), `useGuildMemberships.ts:176` (refetch), and `useSession.ts:328` (cursor-based) differ in invalidation strategy. A generic `useOptimistic` would erase per-feature subtlety. Skip.
- **`api/sessions.ts` and `api/trades.ts` flat dispatch on `?action=…`** is intentional — Vercel's 12-function ceiling forces the consolidation. A router framework would obscure the constraint that's actively buying function slots.
- **Card-key parsing** flagged as a target: there is no shared cardKey string format — the qty bug fix landed via `normalizeRestriction` (`useWants.ts:19`), and `${familyId}::${restrictionKey}` joining only happens in two places (`ListCardPicker.tsx:425`, `SignalBuilderView.tsx:348`). Nothing to consolidate.
- **`Dialog.Root`** is only used in 2 files (`ProposeBar.tsx:534`, `ListsDrawer.tsx:88`). The rest are `window.confirm` + bespoke modals — fine for the volume; don't extract a generic dialog primitive.
- **Wholesale icon-library extraction.** Most of the 33 inline icons are one-offs (`HamburgerIcon`, `ServerIcon`, `BackIcon`, `DiscordIcon`). Only `CloseIcon`/`ChevronIcon`/`CheckIcon` (3+ copies each) are worth pulling out — keep the rest co-located.
