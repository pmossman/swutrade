# Audit Sprint 2 — autonomous execution

Started: 2026-05-01 (after Sprint 1 closed)
Branch: `beta`
Source: `docs/audit-2026-05-01/SYNTHESIS.md` (Sprint 2 = foundational type safety: H4 + H5)

Standing rules same as Sprint 1 (see SPRINT1_PLAN.md). Status legend
identical: `[ ]` / `[~]` / `[x]` / `[B]`.

## Milestones

- [x] **S2.1** — `proposalStatuses` + `ProposalStatus` exported (40010b4 · run 25232808778)
- [x] **S2.2** — Re-export schema types instead of redeclaring (fe1f6ea · run 25233170931)
- [x] **S2.3** — Shared `MeResponse` type (174e580 · run 25233432932)
- [~] **S2.4** — Add zod-validation overload to `apiClient.request()` — `request<T>(method, url, body, schema?)`. Schema validates parsed JSON before the optimistic cast.
- [ ] **S2.5** — Migrate `/api/auth/me` consumer (`useAuth`) to the zod overload as the proof-of-pattern. Defer the other 43 consumers behind opportunistic future migration.

## Run log

| When | Milestone | SHA | CI Run | Result |
|------|-----------|-----|--------|--------|
| — | — | — | — | starting S2.1 |

## Notes

- Sprint 2 is type-safety scaffolding, not behavior change. Tests should stay green throughout.
- `InferSelectModel` may need a type-import workaround if Drizzle's nominal types don't compose cleanly with React props — fall back to hand-rolled exported types if necessary.
- Don't try to migrate all 44 apiClient call sites — synthesis explicitly scopes that as "incremental adoption on hot paths." S2.5 is a pattern demo, not a sweep.
- 83% context budget noted at sprint start; rely on this doc + per-commit CI for resume durability.
