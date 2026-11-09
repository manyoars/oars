// The two keyed values a machine and its trusted machine must compute the same way: the salts the enrollment derives from the store salt, and the skeleton `id` of a session a machine holds. Only node:crypto, so the
// Stop hook's child pays for no pool module to read them.
import { createHmac } from 'node:crypto';

/** The salt a purpose gets: `repoKey/1` keys a repository's hash, `sessionId/1` a machine's session ids. A derived salt computes that one hash and nothing else, so it can leave the trusted machine and the store salt cannot. */
export const derivedSalt = (localSalt: string, purpose: 'repoKey/1' | 'sessionId/1'): string => createHmac('sha256', localSalt).update(purpose).digest('hex');

/** A session's name without the prefix the cloud puts on it: the variable carries `cse_`, the id a teleport takes carries `session_`, and unstripped the two would hash apart and one session would count twice. */
export const sessionName = (session: string): string => session.replace(/^(?:cse_|session_)/u, '');

/** The skeleton `id` of a machine's session: the first 16 hex digits of the session's HMAC under the environment's session salt, the one shape the wire and the outbox accept. */
export const machineIdOf = (sessionSalt: string, session: string): string => createHmac('sha256', sessionSalt).update(sessionName(session)).digest('hex').slice(0, 16);
