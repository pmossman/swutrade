# 13 — Client-side mutation patterns inventory

Walk of every `src/` POST/PUT/DELETE to `/api/*`. `apiClient.ts:43-64` returns a discriminated `ActionResult<T>`; `tradeActions.ts:49-65` is a parallel implementation. No shared mutation primitive — each hook reimplements optimistic/mutex/rollback.

## Inventory

| Caller | Endpoint | Optimistic? | Mutex/lock? | Rollback | Concurrent calls | In-flight UI |
|---|---|---|---|---|---|---|
| `useSession.saveCards` `:326-362` | `PUT .../edit` | Y — local | poll-only ref; **NOT re-entry gated** | `fetchOnce()` | **fires anyway, races** | none |
| `useSession.confirm/unconfirm/cancel` `:364-405` | POST | N | poll-mutex; component flag disables button | silent | dropped | button disabled |
| `useSession.claim` `:407-427` | POST | N | poll-mutex | `fetchOnce` on `!ok` | single button | none |
| `useSession.sendChat` `:429-452` | POST | N | poll-mutex | reason | caller `sending` (`SessionTimelinePanel:114`) | caller flag |
| `useSession.markRead` `:454-469` | POST | N | none — best-effort | swallow | stacks on visibility | none |
| `useSession.suggest` `:487-509` | POST | N | poll-mutex | reason | caller-gated only | composer flag |
| `useSession.accept/dismissSuggestion` `:511-539` | POST | N | poll-mutex | leave divergent | dropped via `SessionSuggestions:73` `busy` | `busy` flag |
| `useSession.proposeRevert` `:541-555` | POST | N | poll-mutex | reason | not gated | none |
| `useServerSync` debounced `:179-204` | `PUT /api/sync/*` | Y (local-leads) | `writingBackRef` + `syncVersionRef` gen-counter | re-pull next foreground | dropped via gen-counter | `'syncing'` |
| `useServerSync` initial `:75-126` | PUT | Y | `writingBackRef` sync-flipped (Lists #1 race) | re-pull | effect-keyed | `'syncing'` |
| `useFavorites.add` `:65-78` | POST `/me/favorites` | **N** — server-leads | none | reason | fires anyway | none |
| `useFavorites.remove` `:80-87` | DELETE | Y — drop local | none | **none** (intentional `:82-84`) | fires anyway | none |
| `useGuildMemberships.updateGuild` `:157-188` | `PUT /me/guilds/<id>` | Y — patch | none | `loadLocal` | **fires anyway, late wins** | `'saving'` |
| `useGuildMemberships.refreshFromDiscord` `:109-134` | POST | N | none | `refreshStatus` | fires anyway | `refreshStatus` |
| `useAccountSettings.update` `:52-64` | `PUT /me/prefs` | Y | none | re-`apiGet` + setSettings | **fires anyway** | `'saving'` |
| `useCommunityMembers.setPeerPref` `:76-108` | `PUT /me/prefs` (peer) | Y — override+effective | none | re-fetch list | **fires anyway** | none |
| `usePopularWants` `:18-42` | POST | N | 300ms debounce + `cancelled` | swallow | dropped | none |
| `useTradeDetail.cancel/accept/decline/promote` `:201-207` | `POST /trades?action=…` | N | `wrap()` `:183-199` `mutating` | cache invalidate + reload | dropped | `mutating` |
| `useTradeDetail.nudge` `:213-221` | POST | N | **none — `wrap` skipped** | reason | fires anyway | caller button |
| `useComposerBar.submit` `:138-178` | caller-supplied | N | machine `kind==='sending'\|'sent'` | `'error'` | dropped | sendState |
| `useAuth.logout` `:105-110` | POST | Y — clear local | none | none | fires anyway | none |
| `useAuth.dismissMergeBanner` `:112-119` | POST | Y — clear local | none | next `/me` | fires anyway | none |
| `SignalBuilderView.postSignal` `:259-280` | POST | N | `posting` | error | dropped | `'Posting…'` |
| `HandlePickerDialog.handleStartSession` `:170-208` | `POST /sessions/create` | N | `startingSession` | error | dropped | disabled |
| `ShareLiveTradeButton.handleClick` `:40-54` | `POST /sessions/create-open` | N | `starting` | swallow | dropped | disabled |
| `TradesHistoryView.handleBulkResolve` `:137-154` | `POST .../bulk-resolve` | N | `bulkState==='running'` | `rowError` | dropped | bulkState |
| `TradeSummary.handleSave` `:182-210` | `POST /trades` (raw `fetch`!) | N | `saveState` machine | `'error'` | dropped | saveState |

## High-impact findings

### 1. Five mutations have the saveCards race shape; three are unguarded

The fixed qty-stepper bug: `useSession.saveCards` lets concurrent invocations through. `mutationInFlightRef` (`useSession.ts:221,328,360`) gates the **poll**, not re-entry. Each click fires its own PUT; last response wins, `applyServerSession` overwrites optimistic in-progress state. Same shape:

- **`useGuildMemberships.updateGuild`** (`:157-188`). Toggle "Enroll" then "Include in rollups" same render: PUT1 + PUT2 in flight, PUT1's canonical lands and overwrites PUT2's patch. No mutex.
- **`useAccountSettings.update`** (`:52-64`) and **`useCommunityMembers.setPeerPref`** (`:76-108`). Both PUT `/api/me/prefs` write-and-pray. Rollback re-`apiGet`s — fourth in-flight request, tighter race.

All three server-canonical-overwrites-optimistic. Same fix (gen-counter ref + drop-stale-response in setState). None caught by unit tests; only e2e `clickAndWaitForEdit` serializes — only on `saveCards`. **Risk:** low. **Effort:** S each. **Confidence:** high.

### 2. `useSession`'s "mutex" protects the poll, not the user

`mutationInFlightRef` blocks `fetchOnce` from clobbering optimistic state during a mutation, but does nothing for *two mutations of the same kind*. Load-bearing for `confirm`/`cancel`/`unconfirm` only because their *callers* (`SessionView.tsx:204-238`) hold component-local state. `saveCards` has no such guard. The contract is "poll-vs-mutation," not "mutation-vs-mutation." **Fix:** rename `pollSuppressedDuringMutationRef`; pair with `withMutationLock` (Synthesis H6). **Risk:** low. **Effort:** S.

### 3. `useFavorites` is asymmetric — `remove` is optimistic, `add` isn't

`remove` (`:80-87`) flips local first then DELETEs. `add` (`:65-78`) waits for server then prepends — slow `add` shows nothing for 200-1000ms while `remove` is instant. **Fix:** optimistic stub on `add`. **Risk:** low. **Effort:** S.

### 4. `useTradeDetail.nudge` skips its own `wrap()` mutex

Every other mutation runs through `wrap` (`:183-199`); `nudge` (`:213-221`) bypasses (not a state transition) but has no double-fire guard. Two taps → two events + two DMs. **Fix:** per-id `nudging` flag. **Risk:** low. **Effort:** XS.

### 5. `TradeSummary.handleSave` bypasses `apiClient`

`TradeSummary.tsx:194` calls raw `fetch` — no `failure()` mapping, generic-error bucket. **Fix:** route through `apiPost`. **Risk:** low. **Effort:** XS.

## Lower-priority debt

- `useSession`'s 11 mutations × `try { ref=true } finally { ref=false }` — `withMutationLock` (Refactor #1) collapses without semantic change.
- `apiClient.ts` + `tradeActions.ts` duplicate `failure()` (`:21-41` ≈ `:33-47`); `__mapFailureForTradeActions` re-export dead.
- `usePopularWants.ts:41` `familyIds.join(',')` as effect dep — brittle.
- `useGuildMemberships.updateGuild` only global `'saving'` — multi-row toggles can't tell which is pending.
- `useFavorites.add`/`dismissMergeBanner`/`logout`/`markRead` swallow errors — no documented "best-effort vs surface" rule.
- `useTradeDetail.wrap` returns `{ok:false, reason:'error'}` on re-entry (`:184`) — caller can't distinguish from real error.
- `TradesHistoryView.handleBulkResolve` no retry path for partial failures.
- `useAccountSettings.update` rollback re-fetches on success too — extra round-trip.
- `useCommunityMembers.setPeerPref` always re-fetches on `value === null` — could skip if response carried cleared effective value.

## Anti-recommendations

Per "don't extract a generic `useOptimistic`" — load-bearing differences:

- **`saveCards` is the only mutation where user input *leads* server response.** Other "optimistic" hooks write a derived value the server canonicalizes — genuinely different shapes.
- **`useFavorites.remove` deliberately doesn't roll back** — server's desired-end-state matches user intent.
- **`markRead`/`dismissMergeBanner` swallow errors** — correctness-neutral audit-log writes.
- **`mutationInFlightRef` isn't a mutex** — it's a poll-pause flag. `withMutationLock` is the separate primitive.
- **`useTradeDetail.nudge` bypasses `wrap` by design** (no page flip). Keep out; add its own throttle.
- **`useComposerBar`'s `kind === 'sending'|'sent'` guard** is correct for single-shot composer.
- **Two `failure()` implementations** — Synthesis N4 will collapse; keep duplicate now.
- **`useServerSync` gen-counter is right for debounce**, not applied to initial `setAll`. Don't homogenize — initial path's race wants `queueMicrotask` (Lists #1), debounce path fine.

**Headline:** 5 hooks have the saveCards race shape (saveCards, updateGuild, useAccountSettings.update, setPeerPref, implicitly nudge). Three are unguarded. The class — *concurrent in-flight PUTs of the same logical resource where response order can clobber optimistic state* — is cross-cutting and would benefit from one shared utility (gen-counter ref + drop-stale-response) without forcing per-feature optimistic-shape convergence.
