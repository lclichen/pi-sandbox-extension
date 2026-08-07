/**
 * Shared constants for the sandbox extension (single source of truth).
 *
 * P3-3: `REMOTE_WORKSPACE` (lib/auth.ts) and `GUEST_WORKSPACE`
 * (lib/operations.ts) were duplicated definitions of the same path — the
 * conventional workspace root inside the remote Apptainer container. Merge
 * them here so workspace hooks and tools stay consistent.
 */

/** The conventional workspace root inside the remote container. */
export const REMOTE_WORKSPACE = "/workspace";
