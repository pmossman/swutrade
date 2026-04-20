# SWUTrade v2

The v2 rewrite. See `docs/v2/brief.md` and `docs/v2/design.md` for vision + architecture. This file is the how-to-run.

## Layout

```
app-v2/
  api/              Vercel serverless functions (v2's own)
  src/              Vite + React source
  public/           Static assets
  index.html        Vite entry
  package.json      v2-specific deps
  vite.config.ts    Vite + Tailwind + Vitest config
  vercel.json       URL rewrites
  tsconfig*.json    Project references (app + node)
```

Imports from the repo root `lib/` (shared with v1) work at build time because they're same-repo relative paths. Vercel project must have **"Include files outside root directory"** enabled — see **Deploy** below.

## Local dev

From `app-v2/`:

```
npm install
npm run dev
```

Vite dev server binds to `:5173`. The `/api/*` functions **don't** run under plain `vite dev` — for auth / trade / session work use `vercel dev` with the project linked:

```
vercel link               # one-time; pick "swutrade-v2" Vercel project
vercel env pull .env.local   # pulls DISCORD_*, SESSION_SECRET, POSTGRES_URL
vercel dev --listen 3000
```

## Build

```
npm run build         # vite build; emits dist/
npm run typecheck     # tsc -b --force
```

Price data files (`public/data/*.json`) are not copied into `app-v2/`. If v2 needs them locally, symlink from the repo root:

```
ln -s ../public/data app-v2/public/data
```

That keeps one source of truth for price data while v1's refresh cron (GitHub Actions hitting the v1 deploy hook) continues to own the pipeline.

## Deploy

v2 is a separate Vercel project from v1. Configuration (one-time, done by the human):

- **Root Directory**: `app-v2`
- **Include files outside root directory**: ON (required for `../lib/*` imports)
- **Framework Preset**: Vite
- **Build Command**: `npm run build`
- **Install Command**: `npm install`
- **Output Directory**: `dist`
- **Environment variables**: copy from v1 project — `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_APP_PUBLIC_KEY`, `SESSION_SECRET`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`. v2 shares the Neon DB.
- **Discord OAuth**: register `https://next.swutrade.com/api/auth/callback` as an additional redirect URI on the same Discord app.

Domain: `next.swutrade.com` until Phase 4 cutover.

## Testing

```
npm run test:run       # vitest unit tests
npx playwright test    # e2e (mobile viewport default)
```

v1's test suite keeps running in v1's CI — nothing is ported by default. When v2 touches shared `lib/*` code, reuse v1's integration tests for that function. See `docs/v2/design.md §7.8`.

## Phase 1 status

Active work plan: sub-phases 1a–1g from `docs/v2/design.md §10`. Progress tracked in `docs/v2/progress.md`.

- **1a** — scaffolding + auth (this commit)
- 1b — layout shell: four tabs + base primitives + dark mode
- 1c — Cards tabs (Binder + Wishlist)
- 1d — Trade canvas (solo)
- 1e — Live trade + QR
- 1f — Async pitch
- 1g — Home list + polish
