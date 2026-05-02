# Audit Sprint 3 — autonomous execution

Started: 2026-05-01 (after Sprint 2 closed + the out-of-band signal-max-$
removal landed)
Branch: `beta`
Source: `docs/audit-2026-05-01/SYNTHESIS.md` (Sprint 3 = the perf cluster:
H2 + H3 + H8 + N10 + N11)

This doc is the resume document if compaction hits during execution.
Each milestone is one commit; one CI verification gates the next.

## Standing rules (same as Sprints 1–2)

- Push only to `beta`. Never `main`. Never `--force`. Never skip hooks.
- One milestone = one commit = one CI verification.
- 3 consecutive CI fails on the same milestone → mark `[B]` BLOCKED.
  Skip to next non-dependent or stop.
- 3 BLOCKED milestones total → stop entirely.
- No `vercel --prod`. No drizzle migrations. No schema changes (defer to RFC).
- Type-checked + relevant-test-passing locally before push (`npx tsc -b --force`).
- Auto-push after commit so CI verifies.
- Watch CI in background with `gh run watch <id> --exit-status` so polling
  doesn't burn context.
- Always `gh run list --limit 1` before pushing a new batch — never stack
  on a still-failing run.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done — annotate `(<sha> · run <id>)` · `[B]` blocked

## Milestones

- [x] **S3.1** — Memoize `AuthContext` + `PriceDataContext` values
      (e56c682 · run 25243972910). `PrimaryActionContext` was already
      memoized — verified, no change needed.
- [ ] **S3.2** — `Promise.all` the sequential-await offenders (H3):
      `handlePropose` proposer/recipient/guild lookups in
      `api/trades.ts`, `syncGuildMemberships` upsert loop in
      `lib/guildSync.ts`, and the 200-card upsert loop in
      `api/sync.ts`.
- [ ] **S3.3** — `React.lazy` the non-builder routes (H8):
      SessionView, SettingsView, CommunityView, SignalBuilderView,
      TradesHistoryView, ProfileView, BinderView, WishlistView,
      TradeDetailView. Trade builder stays eager. Wrap `renderBody()`
      in `<Suspense fallback={…}>`.
- [ ] **S3.4** — Batch the signal embed N+1 (N10): replace per-row
      `resolveFamily` + `resolveVariantSpec` with two `inArray()`
      lookups (wants_items, available_items) in `api/signals.ts` and
      `api/bot.ts`.
- [ ] **S3.5** — Adopt `createSingletonCache` in `useFavorites`,
      `useRecentPartners`, `useCommunityCards`, `useMutualBotGuilds`
      (N11). Mirror the `useTradesList` / `useGuildMemberships`
      pattern. `useMutualBotGuilds` is keyed by counterpart handle —
      use `createKeyedCache` there.

## Run log

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| — | — | — | — | starting S3.1 |

## Notes for the executor

- Sprint 3 is performance-only — no behavior changes should ship.
  Tests should stay green throughout.
- S3.1 is the highest-leverage commit in the sprint by far: every
  context consumer in the app re-renders on every 60s tick today.
  Memoizing the provider values + the `useAuth` return object is the
  whole fix.
- S3.2's three offenders share the same shape (sequential awaits where
  the operations don't depend on each other). Bundle them in one
  commit unless one needs a structural change.
- S3.3's risk surface is the lazy-load barrier: every lazy route
  needs default-export discipline. The `import { X }` named imports in
  `App.tsx` need to flip to `lazy(() => import('…').then(m => ({ default: m.X })))`
  unless the component is already a default export. Check each.
- S3.4: the per-row `resolveFamily` / `resolveVariantSpec` helpers can
  be deleted once batching lands. Keep `lib/signalMatching.ts`'s
  variant-spec logic — only the per-row DB lookups go.
- S3.5: `useMutualBotGuilds` is the only one keyed by an arg
  (`targetHandle`); use `createKeyedCache<string, MutualBotGuildOption[]>`
  there. The other three are global singletons.
- After all 5 land green: append a closing entry to `SYNTHESIS.md`
  summarizing what shipped, then move to Sprint 4 (UX primitive
  consolidation) when parker green-lights.

## References

- `07-performance.md` — full perf audit (this sprint executes findings
  #2, #3, #4, #5; #1 already shipped in S1.5).
- `13-mutation-patterns.md` — gen-counter pattern context (already
  applied in Sprint 1; useful for grading whether new races could
  surface from S3.5's cache adoption).
