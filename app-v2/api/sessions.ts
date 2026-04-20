/*
 * v2 reuses v1's /api/sessions handler. Same dispatcher (get, list,
 * create, edit, confirm, cancel, create-open, claim, invite-handle),
 * same iron-session cookies, same ghost-user mint on create-open /
 * claim. Re-exporting keeps session-write semantics in one place —
 * any v1 patch for race conditions or Discord failures flows to v2
 * automatically.
 */
export {
  default,
  handleGetSession,
  handleListSessions,
  handleCreateSession,
  handleEditSession,
  handleConfirmSession,
  handleCancelSession,
  handleCreateOpenSession,
  handleClaimSession,
  handleInviteHandle,
} from '../../api/sessions.js';
