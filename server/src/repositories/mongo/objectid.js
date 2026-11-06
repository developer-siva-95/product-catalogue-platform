import mongoose from 'mongoose';

/**
 * MongoDB-side id conversion. This file is *below* the repository boundary: it is
 * the only place a service may reach through to build a driver value, and P2
 * moves these call sites into `repositories/mongo/*` entirely.
 *
 * Lives here (rather than in `utils/`) so the ESLint boundary rule can ban
 * `mongoose`/`mysql2` imports from every service and controller.
 */

/**
 * Converts a canonical 24-hex id into a MongoDB ObjectId.
 *
 * Throws the same `BSONError` Mongoose would throw for a malformed value, so call
 * sites that already validated the id keep identical behaviour.
 *
 * @param {string} id
 * @returns {import('mongoose').Types.ObjectId}
 */
export function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}

export default { toObjectId };
