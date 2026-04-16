/**
 * Thin abstraction over Discord's REST API. Every Discord call in
 * the codebase routes through one of these methods — the production
 * `createDiscordClient()` uses `fetch`, tests inject a fake client
 * instead of stubbing `fetch` globally.
 *
 * Keeping this narrow on purpose: the client exposes exactly the
 * endpoints we actually call, typed with response shapes derived
 * from real Discord captures. Adding a new endpoint means adding a
 * new method here plus a test fixture in `tests/fixtures/discord/`.
 *
 * See `PHASE4_TESTING.md` for the authoring discipline.
 */

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  /** Stringified permissions bitfield for the viewer. */
  permissions?: string;
}

export interface DiscordClient {
  /** `GET /users/@me/guilds` — requires user access token. */
  getUserGuilds(accessToken: string): Promise<DiscordGuildSummary[]>;
}

/**
 * Production client. Pointed at `https://discord.com/api` unless
 * overridden (useful for test doubles that stand up a local HTTP
 * server). Errors are re-thrown — callers decide whether to swallow
 * (e.g. `syncGuildMemberships` treats failure as non-fatal).
 */
export function createDiscordClient(opts: { apiBase?: string } = {}): DiscordClient {
  const apiBase = opts.apiBase ?? 'https://discord.com/api';

  return {
    async getUserGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
      const res = await fetch(`${apiBase}/users/@me/guilds`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        throw new Error(`Discord getUserGuilds failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as DiscordGuildSummary[];
    },
  };
}
