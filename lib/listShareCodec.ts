/**
 * Server-side decoder for shared wants/available list URL params.
 *
 * The CLIENT side of this codec lives in `src/urlCodec.ts` — it owns
 * both the encoder and the client-side decoder. This file carries the
 * matching SERVER decoder consumed by `api/og.ts` (for share-image
 * rendering) and its integration tests.
 *
 * Why two decoders exist: `src/urlCodec.ts` imports frontend-only
 * types (`WantsItem` shape with its `restriction` object, etc.) and
 * co-locates with the encoder for client roundtrip testing. The
 * server consumer works with a lighter `acceptedVariants` array
 * shape and must be independently bundled by Vercel's function
 * builder. Keeping a separate decoder module here avoids pulling any
 * browser deps into the function bundle while still being importable
 * from tests without touching the heavy JSON data imports that live
 * at `api/og.ts`'s top level.
 *
 * **Staleness hazard**: any change to the client encoder in
 * `src/urlCodec.ts` (compression scheme, field ordering, flag
 * shorthands) MUST land here too. `tests/api/og-codec.test.ts` is the
 * cross-boundary round-trip that would catch drift. A future slice
 * can unify the two with a shape adapter; until then, keep both
 * sides' tests in sync.
 */

import { inflateSync } from 'fflate';

// Same canonical order as src/variants.ts — kept in sync manually
// because the client codec and this server codec are independently
// bundled and can't share the enum directly. Position is bit-
// significant for wants-URL masks; new variants must be appended,
// never inserted.
const CANONICAL_VARIANTS = [
  'Standard', 'Foil', 'Hyperspace', 'Hyperspace Foil',
  'Prestige', 'Prestige Foil', 'Serialized', 'Showcase',
  'Gold', 'Rose Gold',
] as const;
type CanonicalVariant = typeof CANONICAL_VARIANTS[number];

function maskToVariants(mask: number): CanonicalVariant[] {
  const out: CanonicalVariant[] = [];
  for (let i = 0; i < CANONICAL_VARIANTS.length; i++) {
    if (mask & (1 << i)) out.push(CANONICAL_VARIANTS[i]);
  }
  return out;
}

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 99) return 99;
  return Math.floor(n);
}

// Share URLs for Wants + Available params are deflate+base64url
// compressed by `src/urlCodec.ts::compressParam` (added 2026-04-15 in
// commit `43b7fec` to shrink big lists under URL length limits).
// Compressed payloads carry a `~` prefix so legacy uncompressed URLs
// still decode unchanged — backward compat for share links already
// circulating in Discord.
const COMPRESS_PREFIX = '~';

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = Buffer.from(padded, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decompressParam(param: string): string {
  if (!param.startsWith(COMPRESS_PREFIX)) return param;
  try {
    const deflated = fromBase64Url(param.slice(COMPRESS_PREFIX.length));
    return new TextDecoder().decode(inflateSync(deflated));
  } catch {
    // Malformed compressed payload — return empty so downstream
    // `.split(',')` produces []. Rendering an empty image beats
    // crashing the handler with a 500 on a bad share URL.
    return '';
  }
}

export interface WantsRef {
  familyId: string;
  qty: number;
  acceptedVariants: string[] | null;  // null = any
  isPriority: boolean;
}

export interface AvailableRef {
  productId: string;
  qty: number;
}

export function decodeWants(param: string): WantsRef[] {
  if (!param) return [];
  const raw = decompressParam(param);
  const out: WantsRef[] = [];
  for (const entry of raw.split(',').filter(Boolean)) {
    const fields = entry.split('.');
    if (fields.length < 2) continue;
    const [encId, qtyStr, ...flags] = fields;
    let familyId: string;
    try {
      familyId = decodeURIComponent(encId);
    } catch {
      continue;
    }
    if (!familyId) continue;
    const qty = clampQty(parseInt(qtyStr, 10));
    let acceptedVariants: string[] | null = null;
    let isPriority = false;
    for (const flag of flags) {
      if (flag === 'p') isPriority = true;
      else if (flag.startsWith('r')) {
        const m = parseInt(flag.slice(1), 16);
        if (Number.isFinite(m)) {
          const vs = maskToVariants(m);
          if (vs.length > 0) acceptedVariants = vs;
        }
      }
    }
    out.push({ familyId, qty, acceptedVariants, isPriority });
  }
  return out;
}

export function decodeAvailableRefs(param: string): AvailableRef[] {
  if (!param) return [];
  const raw = decompressParam(param);
  const out: AvailableRef[] = [];
  for (const entry of raw.split(',').filter(Boolean)) {
    const [productId, qtyStr] = entry.split('.');
    if (!productId) continue;
    out.push({ productId, qty: clampQty(parseInt(qtyStr, 10)) });
  }
  return out;
}
