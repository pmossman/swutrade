import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildPayload,
  reportFeedback,
  type FeedbackReport,
} from '../../lib/feedbackReporter.js';

/**
 * Coverage for the feedback Discord-webhook reporter. The reporter
 * shape mirrors lib/errorReporter.ts on purpose; tests follow the
 * same conventions:
 *   - `buildPayload` is pure and tests verify the embed shape +
 *     truncation behavior.
 *   - `reportFeedback` is fire-and-forget — the contract is "never
 *     throw, silent without env var" — and we verify that contract
 *     against a mocked global.fetch.
 */
describe('feedbackReporter', () => {
  describe('buildPayload', () => {
    it('renders a price-kind embed with structured card context', () => {
      const report: FeedbackReport = {
        kind: 'price',
        message: 'TCGPlayer shows $1.50; we show $4.',
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
        context: {
          productId: '12345',
          cardName: 'Luke Skywalker',
          variant: 'Showcase',
          ourPrice: 4,
          priceMode: 'market',
          pageUrl: 'https://swutrade.example/?propose=bob',
        },
      };
      const payload = buildPayload(report) as { embeds: Array<{
        title: string;
        description: string;
        color: number;
      }> };
      expect(payload.embeds).toHaveLength(1);
      const embed = payload.embeds[0];
      expect(embed.title).toContain('Price report');
      // Reporter handle bolded; @ prefix added.
      expect(embed.description).toContain('**@alice**');
      // Quoted message preserves the reporter's text.
      expect(embed.description).toContain('TCGPlayer shows $1.50');
      // Structured card fields included.
      expect(embed.description).toContain('Luke Skywalker');
      expect(embed.description).toContain('Showcase');
      // productId is the load-bearing field — must include it raw
      // PLUS the TCGPlayer URL so triage is one click.
      expect(embed.description).toContain('`12345`');
      expect(embed.description).toContain('https://www.tcgplayer.com/product/12345');
      // Price rendered as $X.XX (market) — formatted, not raw number.
      expect(embed.description).toContain('$4.00');
      expect(embed.description).toContain('(market)');
      expect(embed.description).toContain('https://swutrade.example/?propose=bob');
      // Amber color for price.
      expect(embed.color).toBe(0xF59E0B);
    });

    it('renders ourPrice=null as "N/A (missing)" — captures missing-price reports', () => {
      const report: FeedbackReport = {
        kind: 'price',
        message: 'No price showing on this card',
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
        context: { productId: '999', ourPrice: null, priceMode: 'low' },
      };
      const payload = buildPayload(report) as { embeds: Array<{ description: string }> };
      expect(payload.embeds[0].description).toContain('N/A (missing)');
      expect(payload.embeds[0].description).toContain('(low)');
    });

    it('renders a general-kind embed with a blue color and no card fields', () => {
      const report: FeedbackReport = {
        kind: 'general',
        message: 'The site loads slow on mobile.',
        reporterHandle: null,
        reporterUserId: null,
        context: { pageUrl: 'https://swutrade.example/' },
      };
      const payload = buildPayload(report) as { embeds: Array<{
        title: string;
        description: string;
        color: number;
      }> };
      expect(payload.embeds[0].title).toContain('Feedback');
      expect(payload.embeds[0].description).toContain('_anonymous_');
      expect(payload.embeds[0].description).toContain('The site loads slow');
      expect(payload.embeds[0].description).not.toContain('productId');
      // Blue color for general.
      expect(payload.embeds[0].color).toBe(0x60A5FA);
    });

    it('truncates absurdly long messages to stay under Discord embed limits', () => {
      const huge = 'x'.repeat(5000);
      const report: FeedbackReport = {
        kind: 'general',
        message: huge,
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
      };
      const payload = buildPayload(report) as { embeds: Array<{ description: string }> };
      // Discord embed description limit is 4096; we cap at 3500 with
      // headroom for surrounding chrome lines.
      expect(payload.embeds[0].description.length).toBeLessThanOrEqual(3500);
    });
  });

  describe('reportFeedback (contract)', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
    });

    it('no-ops silently when DISCORD_FEEDBACK_WEBHOOK_URL is unset', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      global.fetch = fetchSpy as unknown as typeof fetch;
      await reportFeedback({
        kind: 'general',
        message: 'hello',
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs the embed payload when env is set', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord/test-webhook';
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      global.fetch = fetchSpy as unknown as typeof fetch;
      await reportFeedback({
        kind: 'price',
        message: 'wrong price',
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
        context: { productId: '12345' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://discord/test-webhook');
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.embeds[0].title).toContain('Price report');
    });

    it('never throws — eats fetch errors so the caller path stays clean', async () => {
      process.env.DISCORD_FEEDBACK_WEBHOOK_URL = 'https://discord/test-webhook';
      global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
      // The contract: this must resolve, not reject.
      await expect(reportFeedback({
        kind: 'general',
        message: 'hello',
        reporterHandle: 'alice',
        reporterUserId: 'user-alice',
      })).resolves.toBeUndefined();
    });
  });
});
