import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * Helpers for signing synthetic Discord interaction payloads with a
 * test Ed25519 keypair. Used by the signed-interaction e2e spec to
 * exercise `/api/bot/interactions` without needing a real human
 * click in a Discord DM.
 *
 * Strategy: the e2e process generates a fresh keypair per run and
 * the test asserts DISCORD_APP_PUBLIC_KEY_TEST (set on the Preview
 * deploy) matches the generated public key. If they mismatch, the
 * test skips — this test is only useful when the preview has been
 * provisioned with a known test key.
 *
 * See `api/bot.ts` for the server-side verification path that
 * accepts either the primary Discord key OR the test key.
 */

export interface TestInteractionKey {
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key in hex — the format Discord's
   *  Developer Portal emits and that `verifyDiscordSignature` expects. */
  publicKeyHex: string;
}

function extractRawEd25519PublicKey(key: KeyObject): string {
  // DER-SPKI export has a 12-byte X.509 prefix before the 32-byte
  // key. Strip it for the Discord-style hex representation.
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('hex');
}

export function generateTestInteractionKey(): TestInteractionKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyHex: extractRawEd25519PublicKey(publicKey),
  };
}

/** Load a previously-generated test key from an env var, or
 *  generate a new one. Returns both the public hex + private key
 *  so callers can sign + assert against the deployed preview. */
export function loadOrGenerateTestKey(): TestInteractionKey {
  const fromEnv = process.env.DISCORD_TEST_PRIVATE_KEY_PEM;
  if (fromEnv) {
    // Not implemented yet — support can be added if we move to a
    // persistent test key checked into CI secrets. For now, every
    // e2e run generates a fresh keypair and requires the matching
    // public key to be present on the preview via
    // DISCORD_APP_PUBLIC_KEY_TEST. That pairs naturally with a
    // deploy-time provisioning step.
    throw new Error('DISCORD_TEST_PRIVATE_KEY_PEM loading not yet wired — generate a fresh key instead');
  }
  return generateTestInteractionKey();
}

export function signInteraction(opts: {
  body: string;
  timestamp: string;
  privateKey: KeyObject;
}): string {
  const message = Buffer.concat([Buffer.from(opts.timestamp), Buffer.from(opts.body)]);
  return sign(null, message, opts.privateKey).toString('hex');
}

/** Builds a Discord MESSAGE_COMPONENT interaction payload shaped
 *  like what Discord POSTs to us when a user clicks a button in
 *  a DM. Only the fields the handler reads are populated. */
export function buildButtonClickPayload(opts: {
  customId: string;
  /** The Discord id of the user who "clicked" the button. */
  clickerDiscordId: string;
}): Record<string, unknown> {
  return {
    type: 3, // MESSAGE_COMPONENT
    data: {
      custom_id: opts.customId,
      component_type: 2, // BUTTON
    },
    user: { id: opts.clickerDiscordId },
    // Discord also emits `application_id`, `id`, `token`, etc. Our
    // handler doesn't read them so we can omit.
  };
}
