/*
 * v2 reuses v1's /api/sync handler wholesale. GET + PUT for both
 * wants and available. See the root api/sync.ts for the full
 * implementation — we re-export so v2's Vercel project gets the
 * serverless function without duplicating the code (and without
 * diverging if v1 patches it).
 */
export {
  default,
  handleWants,
  handleAvailable,
} from '../../api/sync.js';
