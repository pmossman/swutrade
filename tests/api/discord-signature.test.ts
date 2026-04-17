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
  const FIXED_TS = 1700000000;
  const timestamp = String(FIXED_TS);
  const now = () => FIXED_TS;

  it('accepts a correctly-signed payload', () => {
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);

    expect(verifyDiscordSignature({ signature, timestamp, body, publicKeyHex, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);
    const tampered = JSON.stringify({ type: 2 });

    expect(verifyDiscordSignature({ signature, timestamp, body: tampered, publicKeyHex, now })).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, privateKey);

    expect(verifyDiscordSignature({
      signature,
      timestamp: String(FIXED_TS + 1),
      body,
      publicKeyHex,
      now,
    })).toBe(false);
  });

  it('rejects when signed with a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const body = JSON.stringify({ type: 1 });
    const signature = signDiscordStyle(timestamp, body, other.privateKey);

    expect(verifyDiscordSignature({ signature, timestamp, body, publicKeyHex, now })).toBe(false);
  });

  it('returns false (not throw) on malformed hex', () => {
    const body = 'x';
    expect(verifyDiscordSignature({
      signature: 'not-hex-at-all-z',
      timestamp,
      body,
      publicKeyHex,
      now,
    })).toBe(false);
  });

  it('returns false (not throw) on a malformed public key', () => {
    const body = 'x';
    const signature = signDiscordStyle(timestamp, body, privateKey);
    expect(verifyDiscordSignature({
      signature,
      timestamp,
      body,
      publicKeyHex: 'zzz',
      now,
    })).toBe(false);
  });

  describe('timestamp window', () => {
    it('rejects a timestamp older than the default 5-minute window', () => {
      const body = JSON.stringify({ type: 1 });
      const signature = signDiscordStyle(timestamp, body, privateKey);
      // 301s ahead of the signed timestamp — just past the default 300s window.
      expect(verifyDiscordSignature({
        signature,
        timestamp,
        body,
        publicKeyHex,
        now: () => FIXED_TS + 301,
      })).toBe(false);
    });

    it('rejects a timestamp far in the future beyond the default window', () => {
      const body = JSON.stringify({ type: 1 });
      const signature = signDiscordStyle(timestamp, body, privateKey);
      expect(verifyDiscordSignature({
        signature,
        timestamp,
        body,
        publicKeyHex,
        now: () => FIXED_TS - 301,
      })).toBe(false);
    });

    it('accepts a timestamp at the edge of the window', () => {
      const body = JSON.stringify({ type: 1 });
      const signature = signDiscordStyle(timestamp, body, privateKey);
      expect(verifyDiscordSignature({
        signature,
        timestamp,
        body,
        publicKeyHex,
        now: () => FIXED_TS + 300,
      })).toBe(true);
    });

    it('honors a caller-supplied maxSkewSeconds override', () => {
      const body = JSON.stringify({ type: 1 });
      const signature = signDiscordStyle(timestamp, body, privateKey);
      // 60s is well inside the default 300s, so bumping the skew to 10 rejects it.
      expect(verifyDiscordSignature({
        signature,
        timestamp,
        body,
        publicKeyHex,
        maxSkewSeconds: 10,
        now: () => FIXED_TS + 60,
      })).toBe(false);
      expect(verifyDiscordSignature({
        signature,
        timestamp,
        body,
        publicKeyHex,
        maxSkewSeconds: 120,
        now: () => FIXED_TS + 60,
      })).toBe(true);
    });

    it('rejects a non-numeric timestamp', () => {
      const body = JSON.stringify({ type: 1 });
      const signature = signDiscordStyle('not-a-number', body, privateKey);
      expect(verifyDiscordSignature({
        signature,
        timestamp: 'not-a-number',
        body,
        publicKeyHex,
        now,
      })).toBe(false);
    });
  });
});
