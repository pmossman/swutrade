/**
 * Best-effort fire-and-forget post to a Discord channel for user-
 * submitted feedback / problem reports. Mirrors `lib/errorReporter.ts`'s
 * shape on purpose — the contract is the same:
 *
 *   - NEVER throws. A failure here would surface as a 5xx to the
 *     reporter, which is exactly the wrong message ("we couldn't
 *     receive your complaint about us breaking").
 *   - Silent in local dev. `DISCORD_FEEDBACK_WEBHOOK_URL` is a
 *     Vercel Preview + Production env var; local `npm run dev` and
 *     `vitest run` never hit the channel.
 *   - Distinct webhook from the bot-errors one so the dev-facing
 *     channel stays signal-heavy. Bot errors are mostly
 *     server-internal; feedback reports are user-facing and benefit
 *     from a different audience / triage cadence.
 *
 * Two report kinds today:
 *   - `price` — per-card "this price looks wrong" submission. Carries
 *     productId, card display name + variant, the price the UI was
 *     showing, and which price mode (Market / Low) the viewer had on.
 *     Lets parker open the card on TCGPlayer and compare without
 *     guessing what the user saw.
 *   - `general` — open-ended "I want to tell you something" report.
 *     No structured context beyond pageUrl + viewer handle.
 *
 * Future kinds (e.g. "card data wrong", "session bug") plug in by
 * adding to the `kind` union + a new section in the embed builder.
 */

export type FeedbackKind = 'price' | 'general';

export interface FeedbackContext {
  /** Page URL where the report was submitted. Helps reproduce. */
  pageUrl?: string;
  /** Per-card price reports include the product so parker can check
   *  TCGPlayer for the same id. */
  productId?: string;
  /** Display name of the card at the time of report (we may rename
   *  cards later; this captures what the user actually saw). */
  cardName?: string;
  /** Variant label the user was looking at (Standard / Hyperspace /
   *  Showcase / etc.). */
  variant?: string;
  /** The price the UI was rendering at submission time. Null when
   *  the price was missing entirely (the "N/A" case). */
  ourPrice?: number | null;
  /** Which price mode (Market vs Low) was active when the user
   *  reported. The two prices can differ wildly for foils. */
  priceMode?: 'market' | 'low';
}

export interface FeedbackReport {
  kind: FeedbackKind;
  /** Free-text user message. Trimmed + length-validated upstream. */
  message: string;
  /** Optional reporter handle; null for ghosts / signed-out users. */
  reporterHandle: string | null;
  /** Optional reporter user id — useful for parker to look up the
   *  account when triaging. Null for signed-out users. */
  reporterUserId: string | null;
  context?: FeedbackContext;
}

/**
 * Fire-and-forget POST. Returns a Promise so callers that DO want
 * to await can — the API handler typically doesn't, since the
 * 204 response shouldn't block on Discord round-trip latency.
 */
export async function reportFeedback(report: FeedbackReport): Promise<void> {
  const url = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!url) return;

  try {
    const payload = buildPayload(report);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Eat. The reporter's #1 rule: never cause an error itself.
  }
}

/** Exposed for tests. */
export function buildPayload(report: FeedbackReport): object {
  const { kind, message, reporterHandle, reporterUserId, context } = report;
  const titleEmoji = kind === 'price' ? '💰' : '💬';
  const titleLabel = kind === 'price' ? 'Price report' : 'Feedback';
  const title = `${titleEmoji} ${titleLabel}`;

  const lines: string[] = [];

  // Reporter line first — context for who's saying this. Anonymous
  // reports still go through but get marked.
  const who = reporterHandle ? `**@${reporterHandle}**` : '_anonymous_';
  lines.push(`From ${who}`);

  // The user's message gets a quoted block — keeps Discord embed
  // formatting from interpreting characters in the text.
  if (message.trim().length > 0) {
    const quoted = message
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n');
    lines.push('');
    lines.push(quoted);
  }

  // Per-card price context renders as a structured block when
  // present — the productId is the load-bearing field for triage,
  // since it's the canonical id for cross-checking TCGPlayer.
  if (kind === 'price' && context) {
    lines.push('');
    const fields: string[] = [];
    if (context.cardName) fields.push(`**Card:** ${context.cardName}`);
    if (context.variant) fields.push(`**Variant:** ${context.variant}`);
    if (context.productId) {
      fields.push(`**productId:** \`${context.productId}\` — https://www.tcgplayer.com/product/${context.productId}`);
    }
    if (context.ourPrice !== undefined) {
      const priceStr = context.ourPrice == null
        ? 'N/A (missing)'
        : `$${context.ourPrice.toFixed(2)}`;
      const modeStr = context.priceMode ? ` (${context.priceMode})` : '';
      fields.push(`**Our price:** ${priceStr}${modeStr}`);
    }
    if (fields.length > 0) lines.push(fields.join('\n'));
  }

  if (context?.pageUrl) {
    lines.push('');
    lines.push(`Page: ${context.pageUrl}`);
  }

  if (reporterUserId) {
    lines.push('');
    lines.push(`_reporter id_ \`${reporterUserId}\``);
  }

  const color = kind === 'price' ? 0xF59E0B : 0x60A5FA; // amber / blue

  return {
    embeds: [{
      title: truncate(title, 256),
      description: truncate(lines.join('\n'), 3500),
      color,
      footer: { text: footerText() },
      timestamp: new Date().toISOString(),
    }],
  };
}

function footerText(): string {
  const env = process.env.VERCEL_ENV ?? 'unknown';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const shortSha = sha ? sha.slice(0, 7) : undefined;
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  return [
    `env=${env}`,
    branch ? `branch=${branch}` : null,
    shortSha ? `sha=${shortSha}` : null,
  ].filter(Boolean).join(' · ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
