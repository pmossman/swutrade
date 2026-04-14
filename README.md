<p align="center">
  <a href="https://swutrade.com">
    <img src="./public/banner.svg" alt="SWU Trade — Star Wars: Unlimited Trade Calculator" width="720">
  </a>
</p>

<p align="center">
  <a href="https://swutrade.com"><b>swutrade.com</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/pmossman/swutrade/issues">Issues</a> &nbsp;·&nbsp;
  <a href="./ROADMAP.md">Roadmap</a>
</p>

---

Balance Star Wars: Unlimited card trades with live TCGPlayer market prices.

Pick cards for each side of a trade, see running totals, and figure out who owes what to make it fair.

## How it works

- **Cards and prices** both come from TCGPlayer's marketplace search API. `scripts/fetch-prices.ts` discovers every SWU set dynamically, pages through each one, and writes per-set JSON to `public/data/` at build time.
- **The client** reads those static JSON files directly from `/data/*.json` — no runtime API calls for price data.
- **Refreshes** run every 2h via a GitHub Actions cron (`.github/workflows/refresh-prices.yml`) that POSTs to a Vercel deploy hook with `?buildCache=false` to force a re-fetch. See `ROADMAP.md` for the plan to move this off the deploy path.
- **OG previews**: `middleware.ts` intercepts crawler requests to share links and returns an HTML page pointing at `/api/og`, which renders a trade summary image on demand.

## Stack

React 19 + TypeScript + Vite, Tailwind v4, deployed on Vercel (Fluid Compute for the API routes).

## Local development

```bash
npm install
npm run dev
```

The dev server runs against whatever price snapshot is currently in `public/data/`. To pull fresh prices locally:

```bash
npm run fetch-prices:force
```

## Scripts

| Script | What it does |
| --- | --- |
| `dev` | Vite dev server |
| `build` | Fetch prices (cached) → typecheck → build |
| `build:fresh` | Force a price refetch, then build |
| `fetch-prices` | Incremental price fetch into `public/data/` |
| `fetch-prices:force` | Re-fetch everything, ignoring cache |
| `gen:fonts` | Rebuild the font subset used by the OG image route |
| `lint` | ESLint |
| `preview` | Preview the production build |

## Layout

```
api/          Vercel functions — OG image, on-demand price proxy, search
middleware.ts Serves OG preview HTML to crawlers on shared trade URLs
scripts/      Build-time price fetcher + font subsetter for the OG image
src/          React app
public/data/  Baked per-set price JSON (shipped with each deploy)
```

## Attribution

Card data and prices via TCGPlayer. Star Wars: Unlimited is © Fantasy Flight Games / Lucasfilm. This is an unaffiliated fan tool.
