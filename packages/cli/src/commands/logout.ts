import { discover, revokeRefreshToken } from '../oidc.js';
import type { Outcome, RunDeps } from '../cli.js';

const STEP = 'logout';

/** Revokes the stored refresh token at Keycloak, then deletes the credentials. A failed revocation still deletes them. */
export const logout = async (deps: RunDeps): Promise<Outcome> => {
  const stored = await deps.store.read();
  if (stored !== undefined) {
    try {
      await revokeRefreshToken(await discover(stored.issuerUrl, { ...deps, step: STEP }), stored.refreshToken, STEP);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.io.stderr(`The refresh token could not be revoked (${reason}); it stops working by itself when idle.\n`);
    }
  }
  await deps.store.delete();
  return { document: { ok: true }, text: 'Logged out' };
};
