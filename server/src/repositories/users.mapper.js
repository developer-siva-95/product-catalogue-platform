/**
 * Shared user mapper.
 *
 * The `/auth/*` responses must stay byte-identical across providers, so the public
 * user shape is produced here for both implementations instead of being derived
 * from a database document. Key order is part of the contract.
 */

/**
 * @param {object} record user record from a repository
 * @returns {{
 *   id: string, name: string, email: string, role: string, isActive: boolean,
 *   mustChangePassword: boolean, lastLoginAt: Date | null, createdAt: Date,
 *   updatedAt: Date
 * }}
 */
export function toSafeUser(record) {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    isActive: record.isActive,
    mustChangePassword: record.mustChangePassword,
    lastLoginAt: record.lastLoginAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export default { toSafeUser };
