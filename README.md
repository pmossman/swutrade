<p align="center">
  <a href="https://swutrade.com">
    <img src="./public/banner.svg" alt="SWU Trade — Star Wars: Unlimited Trade Calculator" width="720">
  </a>
</p>

<p align="center">
  <a href="https://swutrade.com"><b>swutrade.com</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/pmossman/swutrade/issues">Issues</a> &nbsp;·&nbsp;
  <a href="./ROADMAP.md">Roadmap</a> &nbsp;·&nbsp;
  <a href="./CHANGELOG.md">Changelog</a>
</p>

---

Balance Star Wars: Unlimited card trades with live TCGPlayer market prices.

Pick cards for each side of a trade, see running totals, and figure out who owes what to make it fair. Keep personal Wants and Available lists locally, share them anonymously via link, OS share sheet, QR code, or rendered image, and pull them into trades with one tap.

## How it works

- **Cards and prices** both come from TCGPlayer's marketplace search API. `scripts/fetch-prices.ts` discovers every SWU set dynamically, pages through each one, and writes per-set JSON to `public/data/` at build time.
- **Enrichment**: `scripts/enrich-cards.ts` joins each card to swuapi.com for `cardType`, aspects, traits, and a canonical display name. Anything that doesn't match swuapi (booster boxes, prerelease kits, token collisions) gets dropped here so the UI only ever sees real, playable cards.
- **The client** reads the enriched static JSON directly from `/data/*.json` — no runtime API calls for price data.
- **Lists** (Wants / Available) are persisted to `localStorage` under Zod-validated schemas; URL params `?w=…&a=…` carry them anonymously for sharing. A dedicated `/list` view renders the shared list as a scannable row layout with recipient-side filter controls, and "Start a trade" pipes the sender's wants straight into the Offering-side picker as an active source chip.
- **Sharing surfaces**: the lists drawer's Share popover carries Copy link, OS share sheet (`navigator.share`), Save as image, and a QR code for in-person scanning.
- **Refreshes** run every 2h via a GitHub Actions cron (`.github/workflows/refresh-prices.yml`) that POSTs to a Vercel deploy hook with `?buildCache=false` to force a re-fetch. See `ROADMAP.md` for the plan to move this off the deploy path.
- **OG previews**: `middleware.ts` intercepts crawler requests to shared links (trades and lists) and returns an HTML page pointing at `/api/og`, which renders a summary image on demand.

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
| `build` | Fetch prices (cached) → enrich → typecheck → build |
| `build:fresh` | Force a price refetch and enrichment refetch, then build |
| `fetch-prices` | Incremental price fetch into `public/data/` |
| `fetch-prices:force` | Re-fetch everything, ignoring cache |
| `enrich-cards` | Join TCGPlayer data with swuapi metadata (uses cached swuapi unless stale) |
| `enrich-cards:force` | Force a fresh swuapi fetch before enriching |
| `gen:fonts` | Rebuild the font subset used by the OG image route |
| `test` | Vitest |
| `lint` | ESLint |
| `preview` | Preview the production build |

## Layout

```
api/           Vercel functions — OG image, on-demand price proxy, search
middleware.ts  Serves OG preview HTML to crawlers on shared trade/list URLs
scripts/       Build-time price fetcher + swuapi enricher + font subsetter
src/           React app (trade surface, lists drawer, shared picker)
public/data/   Baked per-set price JSON + family-index (shipped with each deploy)
CHANGELOG.md   Release notes by tag
ROADMAP.md     Vision, phases, design-decision log
```

## Attribution

Card data and prices via TCGPlayer. Star Wars: Unlimited is © Fantasy Flight Games / Lucasfilm. This is an unaffiliated fan tool.
