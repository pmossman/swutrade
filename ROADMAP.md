# Roadmap

Ideas and improvements parked for later. Not commitments — just so we don't lose them.

## Decouple price refresh from deploys

**Today:** Prices are baked into the build (`public/data/*.json`). A 6h GitHub Actions cron pokes a Vercel deploy hook with `?buildCache=false` to force a re-fetch. Each refresh = a full ~5min production deploy.

**Better:** Move price data into Vercel Blob (or KV) and have a Vercel Cron Job hit `/api/refresh-prices` to rewrite it. App reads from the live store. No redeploys for price updates; updates propagate in seconds.

Sketch:
- `api/refresh-prices.ts` runs the fetch logic, writes each set's JSON to Vercel Blob (`access: 'public'`)
- App fetches from `https://<store>.public.blob.vercel-storage.com/data/{slug}.json`
- `vercel.json` cron: `{ path: '/api/refresh-prices', schedule: '0 */6 * * *' }`
- Deploys still seed an initial copy via `scripts/fetch-prices.ts` for first-load before any cron fires
- Delete `.github/workflows/refresh-prices.yml`

Trade: adds a Blob dependency, but prices update without redeploys and we stop burning a 5min build every 6h.

## Existing pending work

- #11 Keep search open + Done button + qty in search
- #12 Allow replacing cards in trade list
- #13 Add creator credit footer
- #14 Fix missing promo/special cards
