# Continuation prompt — foundation pass before Phase 2

You're picking up SWUTrade after `v2026.04.15.2-stable` shipped. Phase 1 (personal lists + anonymous sharing) is complete. The user wants a dedicated session to **harden the foundation** before starting Phase 2 (accounts + Neon/Discord OAuth sync). Do not add new user-facing features — the scope is code quality, type safety, test coverage, and data-layer confidence.

Delete this file when the work lands, or keep updating it if the effort spans multiple sessions.

---

## Project state

- **Branch:** `beta` is your working branch. `main` is stable and tagged `v2026.04.15.2-stable`. Pushing to `beta` rebuilds the preview site; promote to `main` only when cutting a release with a CHANGELOG entry + version tag.
- **Canonical docs:** `ROADMAP.md` (vision + design-decision log), `CHANGELOG.md` (release notes by tag), `README.md` (build + scripts).
- **Not in scope this session:** Phase 2 data model, Discord OAuth, Neon Postgres, new trade / list UX.

---

## Goal

Take a deliberate audit-then-refactor pass. At the end of the session:

1. A short **audit document** (commit it under `docs/audit-YYYY-MM-DD.md` or similar) listing what you examined, what's fine, what's worth fixing, and what you'd defer.
2. Incremental commits that address the higher-value items the user agrees to.
3. Meaningfully improved e2e / integration test coverage so the next major feature push doesn't regress Phase 1.
4. A cleanup of any technical debt the user explicitly confirms they care about.

**Default to proposing before doing.** Start by reading + auditing. Surface candidates to the user with your recommendation before making sweeping changes.

---

## Phase 0: audit before refactoring

Read these in roughly this order before proposing anything:

1. **Data fetching layer** — `scripts/fetch-prices.ts`, `scripts/enrich-cards.ts`, `src/enrichment.ts`, `src/services/priceService.ts`, `src/hooks/usePriceData.ts`. Also `api/og.ts` for how it consumes `family-index.json` + `product-index.json`.
2. **Core domain utilities** — `src/variants.ts`, `src/applySelectionFilters.ts`, `src/listMatching.ts`, `src/urlCodec.ts`, `src/persistence/`.
3. **Biggest components** — `src/components/TradeSide.tsx` (~800 LOC), `src/components/ListsDrawer.tsx`, `src/components/ListCardPicker.tsx`, `src/components/ListView.tsx`, `src/components/SelectionFilterBar.tsx`.
4. **Hooks** — `src/hooks/useSelectionFilters.ts`, `src/hooks/useWants.ts`, `src/hooks/useAvailable.ts`, `src/hooks/useCardSearch.ts`, `src/hooks/useTradeUrl.ts`, `src/hooks/useSharedLists.ts`.

As you read, keep notes on the categories below.

---

## Improvement categories (non-exhaustive — probe each)

### 1. Data-layer accuracy & resilience
- **Enrichment match rate** is ~94%. Several promo sets (Judge Promos, OPP, Prerelease, weekly-play promos for several sets, sector-and-regional) land as "zero matches". Are the set-code overrides in `scripts/enrich-cards.ts` auditable via swuapi? Can we raise the floor without hardcoding fragile mappings?
- **Token / leader collisions** — we fixed Gar Saxon (Experience) and Qi'ra (Shield). Are there others in JTL / LOF / SEC / LAW? Suggest running a diff: "cards with `cardType === 'Leader'` whose number < 20" vs "swuapi Leader record at same canonical id" and report mismatches.
- **Variants outside `CANONICAL_VARIANTS`** — SEC and LOF both have Rose Gold and Gold variants (21-43 each) that currently render as "unknown" in the picker. Either add to the canonical list or explicitly filter them; document the decision in the roadmap.
- **Foil-toggle data gap for SOR / SHD / TWI** is already parked in roadmap with the exact API endpoint; consider picking it up if a user has asked, or bumping its priority.
- **Error paths**: what happens if `family-index.json` is missing? If `manifest.json` is stale? If `fetchSetPrices` 500s? Are user-facing error states consistent?
- **`normalizeCardNumber` edge cases** — we handle `"5"`, `"005"`, `"224/264"`. Confirm with a test fixture; any real-world shape we're missing?
- **`extractVariantLabel` / `extractBaseName`** — regex-based name parsing. Audit fixtures across promo sets where card names include parentheticals that aren't variants (e.g., subtitles, tokens).
- **Price freshness**: is the 2h GH Actions cron actually working? Check the workflow, recent run history, whether `buildCache=false` is still effective. The roadmap has a "decouple refresh from deploys" entry worth considering if this is actively broken.

### 2. Type safety / invariants
- `CardVariant.variant` is typed as `string` but there's a canonical set. Consider narrowing to `string` with a branded type or `CanonicalVariant | string` union where useful. Watch for places we assume it's a canonical value.
- `CardVariant.displayName` and `cardType` are optional at the type level but post-enrichment every card has them. Is there a seam where we can assert enriched vs raw? (E.g., `EnrichedCardVariant` subtype in `usePriceData` output.)
- Zod schemas in `src/persistence/schemas.ts` vs TS types — are they the source of truth, or do they drift? Confirm `z.infer` chain actually drives the TypeScript types rather than duplicating them.
- `VariantRestriction` discriminated union — good shape; make sure every place that touches it exhausts both `mode` branches.

### 3. Component DRY opportunities

Known duplication to investigate (user has seen most of this):
- **Filter chip UIs in `ListView.tsx` vs `SelectionFilterBar.tsx`** — I duplicated the variant / set / preset chip logic inline in ListView because its filter state is ephemeral, not persisted. Consider extracting a shared component that takes either a `useSelectionFilters` API or a plain-useState pair.
- **Card row rendering** — `src/components/ListRows.tsx` (saved wants/available), `src/components/ListView.tsx` (shared-list row), and parts of the trade row in `TradeSide.tsx` all render "thumbnail + name + variant pill + qty + price". Three similar-ish row layouts are borderline worth unifying; five would be obviously worth it. Use judgment.
- **Variant badge rendering** — pill markup duplicated across `ListCardPicker`, `ListView`, `ListRows`, `TradeSide`. A `<VariantBadge variant="Hyperspace" />` or `<VariantBadges variants={['Hyperspace','Hyperspace Foil']} />` could collapse this.
- **Popover** is already shared (good!) but share-popover content / price-slider popover content / kebab menu use different internal styles. See if they can converge on a single "menu item" component.
- **`TradeSide.tsx` is ~800 lines.** Legitimate candidate for splitting — search overlay, trade-card row, AddCardsTile, thumbnail sizing, etc. are all internal pieces that could extract cleanly.

Be careful:
- Tailwind encourages inlining utility strings; don't over-extract to a theme layer unless there's real reuse.
- The color-reservation invariant (emerald/blue = sides, gold/amber/crimson = balance) must survive any style refactor. See `src/index.css` header comment.

### 4. Test coverage
Current suite: 6 test files, 74 tests, all unit-level. No integration or e2e.

**Unit-test gaps that feel actionable right now:**
- `src/applySelectionFilters.ts` — pure function, zero tests despite being load-bearing across picker + list view + trade search.
- `src/hooks/useCardSearch.ts` → `browseAllGroups` — zero tests despite governing the default picker view.
- `src/hooks/useWants.ts` dedup behavior — this was a bug source earlier (familyId + restriction-key keying). Worth regression-testing.
- `src/hooks/useSelectionFilters.ts` — mutual-exclusion rules between group presets and individual chips have their own bug history.
- `src/hooks/useAvailable.ts` basics.

**Integration / e2e tests worth adding (Playwright recommended, not currently installed):**
- Full trade flow: open search, filter, add cards to both sides, check balance math.
- Wants picker with a variant filter → tap → wants list shows restriction → re-tap with different filter → new row created.
- Available picker tap-to-save → qty chip → decrement → remove.
- Share link round-trip: build a list → copy link → open the link → `/list` view renders correctly → "Start a trade" lands on Offering with "They want" chip active.
- URL codec roundtrip through the app (unit tests cover the codec itself, but not the app ingesting a URL it emitted).
- Mobile viewport regression: does the drawer actually fit at 390×844, do pickers remain tappable, do sticky headers stick.
- OG image renders for a known `?w=…&a=…` URL without errors (smoke test the Vercel function).

Suggested approach: add `@playwright/test`, write 5-10 headless tests that cover the most valuable flows. Run in CI via GitHub Actions on the beta deploy URL.

### 5. Accessibility + mobile polish
- Keyboard navigation through the picker grid (virtualization complicates this).
- Focus management when dialogs open / close / switch to picker mode.
- Screen-reader labels on chip toggles and the multi-state share popover.
- Touch-target audit — anything smaller than 32px?
- iOS Safari `100dvh` / safe-area / address-bar shrink behavior — verify in a real browser, not just emulation.

### 6. Perf / bundle
- Run `npm run build` and inspect the bundle output. Anything large we could split or drop?
- Lighthouse pass on the main trade view + `/list` view — any red flags?
- `useMemo` / `useCallback` usage — I sprinkled a lot; confirm they actually prevent re-renders and aren't just ceremony.

### 7. Minor cleanup (low priority; batch at the end)
- `src/components/TradeListsSection.tsx` was just deleted; make sure no tests or unused imports reference it.
- The `Popover` component's `onClick={e => e.stopPropagation()}` on the panel — is that still needed now that click-outside uses pointer events correctly?
- `CardTile` still has a `name` prop passed to an unused `alt`-ish surface after the `alt=""` change. Tidy.
- Stale comments (e.g., any "TODO Phase 2" style markers that have been addressed).

---

## Suggested order of operations

1. **Read everything in Phase 0.** Take ~30-60 min before any edits.
2. **Write the audit doc** (~1-2 paragraphs per category, with concrete file/line pointers for findings). Commit it. Share a summary with the user + your recommendation of which items to tackle vs defer.
3. **Batch 1: unit-test coverage gaps.** Quick wins, catch regressions before the later refactors.
4. **Batch 2: DRY / extraction** the user greenlights. Small commits, each with a before/after screenshot if it's visible.
5. **Batch 3: data-layer audit findings** worth fixing (e.g., Rose Gold / Gold variant handling, any token collisions still lurking).
6. **Batch 4: add Playwright + write the 5-10 e2e tests** agreed on.
7. **Close out:** CHANGELOG entry (even if "internal quality pass — no user-facing changes" is valid), tag `v2026.04.16.X-stable`, update the `## Parked` section of the roadmap if any items graduated.

---

## Rules of engagement for this session

- **Don't add features.** If something surfaces that looks like a feature gap, log it in the roadmap instead.
- **Propose, then execute.** Especially for large refactors (breaking up `TradeSide.tsx`, introducing a card-row component) — confirm the shape with the user first.
- **Don't chase cleanliness past the point of value.** Some duplication is cheaper than the abstraction. Three similar rows < an abstraction; five similar rows probably >.
- **Preserve the color-reservation invariant** (see `src/index.css` header). Don't repurpose emerald / blue / gold / amber / crimson for non-semantic chrome.
- **Keep tests green at every commit.** If a refactor breaks a test, fix the test (or the refactor) in the same commit.
- **No silent behavior changes.** If your cleanup shifts UX, call it out in the commit message.
