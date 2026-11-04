// The covenant gate (V10). It lives at the server because a live URL is reachable by anyone and a CLI check would not hold: with no COVENANT_VERSION nothing can deposit, and once one is set an account must have accepted exactly that version.
import { answer, bodyOf, bound, refuse, textField, type Env } from './http.js';
import { accountOf } from './identity.js';

export const depositsClosed = (): Response => refuse(403, 'deposits_closed', 'This pool is not taking deposits: its covenant is not published.');

export const covenantNotAccepted = (version: string): Response => refuse(403, 'covenant_not_accepted', `Accept covenant ${version} before depositing.`);

/** An older acceptance does not carry over: a new version asks again. */
export const hasAccepted = async (env: Env, account: string, version: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT covenant FROM accounts WHERE id = ?').bind(account).first();
  return textField(row, 'covenant') === version;
};

/** `GET /v1/covenant`: the version is public, so it answers with no sign-in, and `accepted` is then simply false. */
export const covenantStatus = async (request: Request, env: Env): Promise<Response> => {
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return answer(200, { version: null, accepted: false });
  const account = await accountOf(request, env);
  return answer(200, { version, accepted: account !== undefined && (await hasAccepted(env, account, version)) });
};

/** `POST /v1/covenant/accept`: naming the version is the acceptance, so a client that read an older one cannot accept a newer one it never saw. */
export const covenantAccept = async (request: Request, env: Env): Promise<Response> => {
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const named = textField(await bodyOf(request), 'version');
  if (named === undefined) return refuse(400, 'missing_field', 'An acceptance names its version.', 'version');
  if (named !== version) return refuse(409, 'covenant_version', `The covenant in force is ${version}, not ${named}.`, 'version');
  await env.DB.prepare('UPDATE accounts SET covenant = ? WHERE id = ?').bind(version, account).run();
  return answer(200, { ok: true, version });
};
