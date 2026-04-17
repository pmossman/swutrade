import { createPublicKey, verify } from 'node:crypto';

/**
 * Verifies an Ed25519 signature from Discord on an HTTP Interactions
 * or Event Webhooks request.
 *
 * Discord signs `timestamp || body` (concatenated as raw bytes) with
 * the application's Ed25519 private key. The public key is available
 * on the application's General Information page in the Developer
 * Portal and stored in `DISCORD_APP_PUBLIC_KEY`.
 *
 * A failed verification MUST produce a 401 — Discord rejects the
 * configured endpoint URL during setup if it accepts a bad signature,
 * and per the docs any production request that fails verification
 * must be rejected.
 *
 * @returns true if the signature is authentic, false otherwise.
 *          Throws are swallowed and returned as `false` so callers
 *          don't need a try/catch around every verify.
 */
export function verifyDiscordSignature(opts: {
  /** Value of the `X-Signature-Ed25519` request header (hex). */
  signature: string;
  /** Value of the `X-Signature-Timestamp` request header. */
  timestamp: string;
  /** Raw request body as a string — must be the bytes Discord signed,
   *  not a re-serialized JSON.stringify(parsedBody). */
  body: string;
  /** Hex-encoded Ed25519 public key from the Developer Portal. */
  publicKeyHex: string;
  /** Max allowed skew between X-Signature-Timestamp and the current
   *  time, in seconds. Defaults to 300 (5 min). Set to `Infinity` or
   *  a very large number to opt out (e.g., tests pinning an arbitrary
   *  timestamp). Prevents replay of captured button-click signatures. */
  maxSkewSeconds?: number;
  /** Clock injection for tests. Returns current Unix time in seconds. */
  now?: () => number;
}): boolean {
  try {
    const maxSkew = opts.maxSkewSeconds ?? 300;
    const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(now - ts) > maxSkew) return false;

    const signature = Buffer.from(opts.signature, 'hex');
    const signedMessage = Buffer.concat([
      Buffer.from(opts.timestamp),
      Buffer.from(opts.body),
    ]);
    // node:crypto's Ed25519 verify wants a PublicKey object. Discord
    // hands us the raw 32-byte key as hex; wrap it in the X.509 SPKI
    // prefix so createPublicKey accepts it.
    const publicKeyDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(opts.publicKeyHex, 'hex'),
    ]);
    const publicKey = createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });
    return verify(null, signedMessage, publicKey, signature);
  } catch {
    return false;
  }
}
