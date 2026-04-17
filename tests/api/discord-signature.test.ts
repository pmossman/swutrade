import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { verifyDiscordSignature } from '../../lib/discordSignature.js';

/**
 * The signature verifier is the first line of defence for every
 * Discord-initiated HTTP call — PING handshakes, slash commands,
 * button interactions, event webhooks. Break this and Discord
 * rejects our interactions URL during configuration.
 *
 * Tests use a locally-generated Ed25519 keypair so we exercise the
 * *real* crypto path without needing Discord's production key.
 * Only the source of the key material differs from production.
 */

function extractRawEd25519PublicKey(key: KeyObject): string {
  // Export as DER-SPKI and strip the 12-byte X.509 prefix to get the
  // raw 32-byte Ed25519 key, which is what Discord hands us (in hex).
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(12).toString('hex');
}

function signDiscordStyle(timestamp: string, body: string, privateKey: KeyObject): string {
  const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]);
  return sign(null, message, privateKey).toString('hex');
}

describe('verifyDiscordSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = extractRawEd25519PublicKey(publicKey);

  it('accepts a correctly-signed payload', () => {
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);

    expect(verifyDiscordSignature({ signature, timestamp, body, publicKeyHex })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);
    const tampered = JSON.stringify({ type: 2 });

    expect(verifyDiscordSignature({ signature, timestamp, body: tampered, publicKeyHex })).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);

    expect(verifyDiscordSignature({
      signature,
      timestamp: '1700000001',
      body,
      publicKeyHex,
    })).toBe(false);
  });

  it('rejects when signed with a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const timestamp = '1700000000';
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, other.privateKey);

    expect(verifyDiscordSignature({ signature, timestamp, body, publicKeyHex })).toBe(false);
  });

  it('returns false (not throw) on malformed hex', () => {
    const timestamp = '1700000000';
    const body = 'x';
    expect(verifyDiscordSignature({
      signature: 'not-hex-at-all-z',
      timestamp,
      body,
      publicKeyHex,
    })).toBe(false);
  });

  it('returns false (not throw) on a malformed public key', () => {
    const timestamp = '1700000000';
    const body = 'x';
    const signature = signDiscordStyle(timestamp, body, privateKey);
    expect(verifyDiscordSignature({
      signature,
      timestamp,
      body,
      publicKeyHex: 'zzz',
    })).toBe(false);
  });
});
