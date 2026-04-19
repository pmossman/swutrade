import {
  DiscordApiError,
  DiscordNotFoundError,
  DiscordPermissionError,
  DiscordRateLimitError,
  DiscordServerError,
  DiscordValidationError,
} from './discordErrors.js';

/**
 * Best-effort out-of-band error reporting to Discord's `#bot-errors`
 * channel. A POST here runs ALONGSIDE the existing `console.error`
 * in the catch block — not as a replacement — so Vercel logs remain
 * the primary record. The Discord post is for human attention:
 * things that SHOULD never happen in prod, things that historically
 * fail silently (`delivery_status=failed`), things worth looking at
 * on your phone without opening the Vercel dashboard.
 *
 * Contract:
 *   - NEVER throws. A failure in the reporter would cascade back into
 *     the catch that called it, which is exactly the pattern we're
 *     trying to add observability to.
 *   - NEVER blocks the request. The POST is fire-and-forget; the
 *     caller shouldn't `await` it unless it specifically wants to.
 *   - Silent in local development. `DISCORD_ERROR_WEBHOOK_URL` lives
 *     on Vercel Preview + Production only, so local `vitest run` and
 *     `npm run dev` never hit the channel.
 *   - Filters expected transient/noise errors so the channel stays
 *     signal-heavy: 429 rate limits (retry handles), 404s for gone
 *     resources (normal lifecycle), DMs-disabled 403s (user choice).
 */

export interface ErrorReportContext {
  /** Short label identifying the catch site. Convention: dot-separated
   *  path, e.g. `trades.propose.dm-send`, `bot.auto-create-channel`. */
  source: string;
  /** Optional structured facts that scope the error. Stringified to
   *  at most 60 chars each. Use for things like `tradeId`, `guildId`,
   *  `userId` — don't shove raw request bodies in here. */
  tags?: Record<string, string | number | null | undefined>;
  /** Override the default filter and alert anyway. Use sparingly,
   *  e.g. when a "normally-noise" error appears where it shouldn't. */
  force?: boolean;
}

/**
 * Fire-and-forget alert to `#bot-errors`. Returns a Promise so callers
 * that DO want to await can, but the common case is to call without
 * awaiting so the error path stays as close to synchronous as
 * possible.
 */
export async function reportError(ctx: ErrorReportContext, err: unknown): Promise<void> {
  const url = process.env.DISCORD_ERROR_WEBHOOK_URL;
  if (!url) return;

  try {
    if (!ctx.force && (shouldSkip(err) || isTestTraffic(ctx, err))) return;
    const payload = buildPayload(ctx, err);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Eat. The reporter's #1 rule: never cause an error itself.
  }
}

/**
 * Exposed for tests. Recognizes alerts triggered by our own test
 * harness — auth e2e specs seed users with synthetic IDs (`test-iso-…`,
 * `e2e-sender-…`) that Discord rejects as non-snowflake, and that
 * rejection IS the expected path for those tests. Filtering here
 * keeps the channel signal-heavy for real production traffic.
 *
 * Two complementary checks:
 *   1. Tag-prefix — any tag value starting with a known test prefix.
 *      Fast, precise when callers set tags (we always do for Discord
 *      flows).
 *   2. Error body — "NUMBER_TYPE_COERCE" on `recipient_id` is Discord's
 *      exact signature for "you passed a non-snowflake user id."
 *      Catches cases where a new test helper misses the tag convention.
 */
export function isTestTraffic(ctx: ErrorReportContext, err: unknown): boolean {
  const TEST_ID_PREFIXES = ['test-iso-', 'e2e-sender-', 'dev-seed-'];
  if (ctx.tags) {
    for (const v of Object.values(ctx.tags)) {
      if (typeof v === 'string' && TEST_ID_PREFIXES.some(p => v.startsWith(p))) {
        return true;
      }
    }
  }
  if (err instanceof DiscordApiError && err.bodySnippet) {
    if (err.bodySnippet.includes('NUMBER_TYPE_COERCE') && err.bodySnippet.includes('recipient_id')) {
      return true;
    }
  }
  return false;
}

/**
 * Exposed for tests. Classes of error that are normal operational
 * noise — we don't alert on them because a human looking at the
 * channel would just tune them out, which weakens the real-signal
 * value of the rest.
 */
export function shouldSkip(err: unknown): boolean {
  if (err instanceof DiscordRateLimitError) return true;
  if (err instanceof DiscordNotFoundError) {
    // 10003 Unknown Channel, 10008 Unknown Message, 10013 Unknown
    // User — all resource-gone cases from normal lifecycle churn.
    const code = err.discordCode;
    if (code === 10003 || code === 10008 || code === 10013) return true;
  }
  if (err instanceof DiscordPermissionError) {
    // 50007 = Cannot send messages to this user (DMs disabled). The
    // user chose this; not a bug.
    if (err.discordCode === 50007) return true;
  }
  return false;
}

/** Exposed for tests. */
export function buildPayload(ctx: ErrorReportContext, err: unknown): object {
  const title = `⚠ ${ctx.source}`;
  const lines: string[] = [];

  if (err instanceof Error) {
    lines.push(`**${err.constructor.name}**: ${truncate(err.message, 400)}`);
    if (err instanceof DiscordApiError) {
      lines.push(`status \`${err.status}\`${err.discordCode != null ? ` · code \`${err.discordCode}\`` : ''} · \`${err.method} ${err.path}\``);
      if (err.bodySnippet) {
        lines.push('```\n' + truncate(err.bodySnippet, 400) + '\n```');
      }
    } else if (err.stack) {
      // Trim to the first handful of stack frames so the embed stays
      // under Discord's 4096-char description limit even for deep
      // stacks. Callers rarely need more than the top of the stack.
      const frames = err.stack.split('\n').slice(0, 6).join('\n');
      lines.push('```\n' + truncate(frames, 800) + '\n```');
    }
  } else {
    lines.push(`**Non-Error throw**: ${truncate(String(err), 400)}`);
  }

  if (ctx.tags) {
    const tagStr = Object.entries(ctx.tags)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=\`${truncate(String(v), 60)}\``)
      .join(' · ');
    if (tagStr) lines.push(tagStr);
  }

  return {
    embeds: [{
      title: truncate(title, 256),
      description: truncate(lines.join('\n'), 3500),
      color: colorFor(err),
      footer: { text: footerText() },
      timestamp: new Date().toISOString(),
    }],
  };
}

function colorFor(err: unknown): number {
  if (err instanceof DiscordValidationError) return 0xDC2626; // red — bug
  if (err instanceof DiscordPermissionError) return 0xF59E0B; // amber
  if (err instanceof DiscordServerError) return 0x3B82F6;     // blue — Discord's fault
  if (err instanceof Error) return 0xEF4444;                  // red default
  return 0x6B7280;                                            // gray — non-Error
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
