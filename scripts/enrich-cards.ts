/**
 * Build-time script: enriches TCGPlayer card records in public/data/
 * with metadata from swuapi.com (baseCardId, type, aspects, traits).
 *
 * Falls back to synthesized baseCardIds when swuapi is unreachable or
 * a card doesn't match — the build never fails on enrichment errors.
 *
 * Cache: scripts/cache/swuapi-all.json (gitignored). Fetched once per
 * week unless ENRICH=1 forces a refresh.
 *
 * Run: npx tsx scripts/enrich-cards.ts
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { SETS } from '../src/types/index.js';
import {
  buildLookup,
  enrichCard,
  type SwuApiCard,
} from '../src/enrichment.js';
import type { CardVariant } from '../src/types/index.js';
import { cardFamilyId, extractVariantLabel } from '../src/variants.js';

const SWUAPI_URL = 'https://api.swuapi.com/export/all';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Overrides for swuapi set codes that don't match our SETS[].code. Extend
// this as unmatched sets are discovered.
//
// Audit verified against scripts/cache/swuapi-all.json on 2026-04-15:
//
//   Mapped (this table)    — overrides below.
//   Mapped by SETS[].code  — SOR, SHD, TWI, SEC, LOF, JTL, LAW, IBH (the
//                            seven main sets + Intro Battle Hoth all
//                            share their TCGPlayer slug with their
//                            swuapi setCode, so no override needed).
//   No swuapi taxonomy     — OPP (organized-play-promos), SRP (sector-and
//                            -regional-promos-season-1), EEP (event-
//                            exclusive-promos), ATE (ashes-of-the-empire),
//                            SORW / SHDW / TWIW (only the 4 newest sets
//                            have weekly-play promos in swuapi). These
//                            stay at 0% enrichment by design — keep
//                            synthesized baseCardIds.
//   Splits across years    — JP (J24+J25), PRP (P25+P26). TCGPlayer's
//                            single slug doesn't carry the year and the
//                            collector numbers don't align cleanly across
//                            yearly sub-sets, so a multi-code lookup
//                            generates false matches (verified — Ki-Adi
//                            -Mundi #2 would inherit K-2SO's metadata).
//                            Skip until a per-card disambiguator (name +
//                            number, or a year column) lands.
const SET_CODE_OVERRIDES: Record<string, string> = {
  CON24: 'C24',
  CON25: 'C25',
  GB25:  'G25',  // 2025 Gift Box
  GGP:   'GG',   // Gamegenic Promos
  LAWW:  'LAWP', // LAW weekly play promos
  JTLW:  'JTLP',
  LOFW:  'LOFP',
  SECW:  'SECP',
  TS:    'TS26', // Twin Suns
};

// SETS[].code values that are intentionally left unmapped. Listed
// explicitly so the regression guard at the bottom of main() doesn't
// fail on them — and so someone investigating a 0% set sees this
// table and the comment above before re-doing the audit.
const KNOWN_UNMAPPED = new Set([
  'OPP', 'SRP', 'EEP', 'ATE', 'SORW', 'SHDW', 'TWIW', 'JP', 'PRP',
]);

function slugToSwuCode(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const s of SETS) {
    map[s.slug] = SET_CODE_OVERRIDES[s.code] ?? s.code;
  }
  return map;
}

async function fetchSwuApi(): Promise<SwuApiCard[]> {
  const res = await fetch(SWUAPI_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`swuapi returned ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  // The export endpoint can return either { cards: [...] } or a raw array.
  // Accept both shapes defensively.
  if (Array.isArray(data)) return data as SwuApiCard[];
  if (Array.isArray(data.cards)) return data.cards as SwuApiCard[];
  throw new Error('swuapi /export/all returned unexpected shape');
}

async function loadOrFetchCards(cachePath: string, force: boolean): Promise<SwuApiCard[]> {
  if (!force && existsSync(cachePath)) {
    const age = Date.now() - statSync(cachePath).mtimeMs;
    if (age < CACHE_MAX_AGE_MS) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as SwuApiCard[];
      console.log(`  Using cached swuapi data (${cached.length} cards, ${Math.round(age / 3_600_000)}h old)`);
      return cached;
    }
    console.log('  swuapi cache is stale, refetching...');
  }
  console.log('  Fetching swuapi /export/all...');
  const cards = await fetchSwuApi();
  mkdirSync(join(cachePath, '..'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cards));
  console.log(`  Cached ${cards.length} cards to ${cachePath}`);
  return cards;
}

async function main() {
  const dataDir = join(import.meta.dirname, '..', 'public', 'data');
  const cachePath = join(import.meta.dirname, 'cache', 'swuapi-all.json');

  if (!existsSync(join(dataDir, 'manifest.json'))) {
    console.log('Skipping enrichment — no manifest. Run fetch-prices first.');
    return;
  }

  const force = process.env.ENRICH === '1' || process.argv.includes('--force');

  let swuCards: SwuApiCard[];
  try {
    swuCards = await loadOrFetchCards(cachePath, force);
  } catch (err) {
    console.warn(`  swuapi fetch failed: ${(err as Error).message}`);
    console.warn('  Proceeding with synthesized baseCardIds only.');
    swuCards = [];
  }

  const lookup = buildLookup(swuCards);
  const slugToCode = slugToSwuCode();

  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf-8'));
  const slugs = Object.keys(manifest.sets ?? {});

  let totalCards = 0;
  let matchedCards = 0;
  let droppedNonCards = 0;
  const unmatchedSets = new Set<string>();
  // Per-slug match counts feed the regression guard at the bottom.
  const matchedPerSlug: Record<string, number> = {};
  const totalPerSlug: Record<string, number> = {};

  // Family index: familyId → list of {productId, variant, prices}.
  // Used by api/og.ts to render OG list images without needing the
  // full per-set JSONs (those are megabytes).
  type FamilyEntry = {
    p: string;            // productId
    v: string;            // variant label
    m: number | null;     // marketPrice
    l: number | null;     // lowPrice
    n: string;            // display name (variant-stripped)
    t?: string;           // cardType — populated when enriched
                          // (Leader / Unit / Event / Upgrade / Base /
                          // Token *). Optional so unenriched promo
                          // sets that don't carry swuapi metadata
                          // serialize without a `null` field.
  };
  const familyIndex: Record<string, FamilyEntry[]> = {};

  for (const slug of slugs) {
    const setPath = join(dataDir, `${slug}.json`);
    if (!existsSync(setPath)) continue;

    const cards: CardVariant[] = JSON.parse(readFileSync(setPath, 'utf-8'));
    let setMatched = 0;

    const enriched = cards.map(card => {
      const result = enrichCard(card, lookup, { slugToCode });
      const hasRealMatch = result.baseCardId && result.displayName !== undefined;
      if (hasRealMatch) {
        setMatched += 1;
        matchedCards += 1;
      }
      totalCards += 1;
      return result;
    });

    // swuapi is the authority on what counts as a real SWU card. If
    // this set had any real matches, we trust that everything else
    // without a recognized cardType is a non-card SKU (booster packs,
    // spotlight decks, prerelease kits) or a TCGPlayer mismatch.
    // Token Unit / Token Upgrade matches also drop — tokens aren't
    // sold as standalone SKUs, so those are enrichment collisions
    // (see buildLookup note). For sets with zero matches (e.g. Judge
    // Promos whose swuapi set codes don't cleanly map), keep
    // everything — filtering on an unenriched set would nuke real
    // cards.
    const cleaned = setMatched > 0
      ? enriched.filter(c => {
          if (!c.cardType) {
            droppedNonCards += 1;
            return false;
          }
          if (c.cardType === 'Token Unit' || c.cardType === 'Token Upgrade') {
            droppedNonCards += 1;
            return false;
          }
          return true;
        })
      : enriched;

    // Family index: familyId → list of {productId, variant, prices}.
    // Built from cleaned rows so OG image renders don't see products
    // either.
    for (const result of cleaned) {
      if (!result.productId) continue;
      const fid = cardFamilyId(result);
      const variant = result.variant || extractVariantLabel(result.name);
      const displayName = result.displayName ?? result.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (!familyIndex[fid]) familyIndex[fid] = [];
      familyIndex[fid].push({
        p: result.productId,
        v: variant,
        m: result.marketPrice,
        l: result.lowPrice,
        n: displayName,
        ...(result.cardType ? { t: result.cardType } : {}),
      });
    }

    if (setMatched === 0 && cards.length > 0) unmatchedSets.add(slug);
    matchedPerSlug[slug] = setMatched;
    totalPerSlug[slug] = cards.length;
    writeFileSync(setPath, JSON.stringify(cleaned));
  }

  writeFileSync(
    join(dataDir, 'family-index.json'),
    JSON.stringify(familyIndex),
  );

  const matchRate = totalCards > 0 ? Math.round((matchedCards / totalCards) * 100) : 0;
  console.log(`\nEnriched ${matchedCards} / ${totalCards} cards (${matchRate}%)`);
  if (droppedNonCards > 0) {
    console.log(`Dropped ${droppedNonCards} non-card SKUs (boosters, decks, unmatched items)`);
  }
  console.log(`Wrote family-index.json with ${Object.keys(familyIndex).length} families`);
  if (unmatchedSets.size > 0) {
    console.log(`\n⚠️  Sets with zero matches (check SET_CODE_OVERRIDES):`);
    [...unmatchedSets].sort().forEach(s => console.log(`    - ${s}`));
  }

  // Regression guard: any SETS entry whose code is mapped (via overrides
  // OR via SETS[].code matching swuapi directly) MUST enrich at least
  // one card. A zero-match drop usually means swuapi changed a code, our
  // SETS table got typo'd, or an override was removed by mistake — all
  // of which silently bake bad data into the deploy if we don't fail
  // loud. Sets in KNOWN_UNMAPPED are excluded since they're zero by
  // design.
  //
  // Skipping the check entirely when swuapi was unreachable (lookup
  // came back empty) — the warning above already explains we're
  // running in synthesized-IDs-only mode.
  if (lookup.total === 0) {
    return;
  }
  const regressions: Array<{ slug: string; code: string; total: number }> = [];
  for (const set of SETS) {
    if (KNOWN_UNMAPPED.has(set.code)) continue;
    const total = totalPerSlug[set.slug] ?? 0;
    if (total === 0) continue; // set wasn't in this build's manifest
    const matched = matchedPerSlug[set.slug] ?? 0;
    if (matched === 0) {
      regressions.push({
        slug: set.slug,
        code: SET_CODE_OVERRIDES[set.code] ?? set.code,
        total,
      });
    }
  }
  if (regressions.length > 0) {
    console.error('\n❌ Enrichment regression — these mapped slugs got 0 matches:');
    for (const r of regressions) {
      console.error(`    - ${r.slug} (mapped to ${r.code}, ${r.total} cards in TCGPlayer)`);
    }
    console.error(
      '\nLikely causes: swuapi changed a setCode, or SETS[].code drifted.\n' +
      'If the zero-match is intentional, add the SETS[].code to KNOWN_UNMAPPED.',
    );
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Failed to enrich cards:', err);
  process.exit(1);
});
