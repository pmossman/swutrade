/**
 * Shared decoder for wants/available list-share URL params.
 *
 * Consumed by:
 *   - `api/og.ts` — server-side share-image rendering
 *   - `src/urlCodec.ts` — client-side decoder (via shape-adapter
 *     wrappers that translate `WantsRef` → `WantsUrlEntry` for
 *     frontend-friendly types with `restriction` instead of
 *     `acceptedVariants`)
 *
 * One decoder implementation, tested by both `tests/api/og-codec.
 * test.ts` (cross-boundary round-trip) and `src/urlCodec.test.ts`
 * (client-side encode/decode round-trip). Before unification
 * (2026-04-21) the client + server had parallel decoders that
 * diverged silently — compression added to one side and not the
 * other caused the share-list-image bug of 2026-04-20.
 *
 * Isomorphism contract: this module works in both browser and Node
 * runtimes. Uses `atob` (available in both Node 16+ and all modern
 * browsers) rather than Node's `Buffer` for base64 decoding, and
 * relies on `TextDecoder` + `fflate.inflateSync` which are both
 * isomorphic. No browser-only globals (`window`, `document`, `localStorage`)
 * and no server-only deps (Node `Buffer`, `fs`).
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
  // atob is available in both modern browsers and Node 16+; avoids
  // pulling Node's `Buffer` into the module so it stays isomorphic
  // and the client bundle (via src/urlCodec.ts) doesn't need a
  // Buffer polyfill. `atob` is strict about padding + invalid chars
  // — callers wrap this in try/catch via `decompressParam` below.
  const binary = atob(padded);
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
