/**
 * Domain-error tags for the session endpoints. The server's dispatcher
 * (`api/sessions.ts`) returns these via `{ error: '<tag>' }` with status
 * 400; passing the matching list to `apiClient` via `domainErrors`
 * narrows the client's `result.reason` to the typed union so callers
 * can switch exhaustively instead of pattern-matching strings.
 *
 * Each constant is `readonly [...] as const` so TypeScript infers the
 * literal union as a string-literal tuple. New tags land in this file
 * first, then in the server dispatcher — keeping both sides in lockstep.
 */

export const DECLINE_ERRORS = [
  'not-active',
  'no-counterpart',
  'note-too-long',
] as const;
export type DeclineError = typeof DECLINE_ERRORS[number];

export const CHAT_ERRORS = [
  'invalid',
  'too-long',
  'empty',
  'terminal',
] as const;
export type ChatError = typeof CHAT_ERRORS[number];

export const SUGGEST_ERRORS = [
  'empty',
  'open-slot',
  'invalid-target',
  'terminal',
  'cap-exceeded',
  'card-locked',
] as const;
export type SuggestError = typeof SUGGEST_ERRORS[number];

export const REVERT_ERRORS = [
  'open-slot',
  'terminal',
  'no-such-snapshot',
  'cap-exceeded',
  'no-op',
] as const;
export type RevertError = typeof REVERT_ERRORS[number];

export const CLAIM_ERRORS = [
  'self',
  'conflict',
  'not-active',
] as const;
export type ClaimError = typeof CLAIM_ERRORS[number];

// Universal codes that appear on multiple endpoints. Imported by
// callers that need to narrow on (e.g.) "loader said the session
// doesn't exist or the viewer can't see it" — the canonical
// projection of the lifecycle loader's typed reasons.
export const SESSION_LOADER_ERRORS = [
  'not-found',
  'not-participant',
  'not-active',
] as const;
export type SessionLoaderError = typeof SESSION_LOADER_ERRORS[number];
