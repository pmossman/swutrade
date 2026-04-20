/*
 * Dynamic route /api/user/:handle — same public-profile shape v1
 * exposes. Re-export so v2 gets its own serverless function without
 * duplicating the read logic.
 */
export { default } from '../../../api/user/[handle].js';
