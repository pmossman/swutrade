/*
 * v2 reuses v1's /api/trades handler. Full proposal lifecycle —
 * propose, get, list, cancel, accept, decline, counter, edit, nudge,
 * bulk-resolve, promote-to-shared. One re-export keeps v2 deploys
 * under the function ceiling and in sync with any v1 patch.
 */
export {
  default,
  handlePropose,
  handleGetProposal,
  handleProposalsList,
  handleCancel,
  handleAcceptDecline,
  handleCounter,
  handleEdit,
  handleNudge,
  handleBulkResolve,
  handlePromoteToShared,
  handleSavedTrades,
} from '../../api/trades.js';
