// What every route shares: the bindings and how an answer is written. A refusal always names its error, and its field when one is to blame.

interface Bound {
  first: () => Promise<unknown>;
  all: () => Promise<{ results: readonly unknown[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
}

/** The part of a D1 binding this server uses, so the code does not take the ambient Workers types, which clash with Node's. */
export interface PoolDb {
  prepare: (sql: string) => { bind: (...values: (string | number | null)[]) => Bound };
}

/** Every value but `DB` is a binding the deploy sets, so a secret lives in the account and never in the config. Unset ones refuse the route that needs them. */
export interface Env {
  DB: PoolDb;
  PSEUDONYM_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** An Ed25519 private key as a JWK. */
  SLICE_SIGNING_KEY?: string;
  /** Unset keeps deposits closed (V10). */
  COVENANT_VERSION?: string;
  /** How many reads an account with no deposit may be served. */
  READ_CAP?: string;
  MAX_DEPOSITS_PER_ACCOUNT?: string;
}

export const answer = (status: number, body: object): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const refuse = (status: number, error: string, message: string, field?: string): Response => answer(status, { error, message, ...(field === undefined ? {} : { field }) });

/** A binding with a value; an empty one counts as unset, the way a blank secret should. */
export const bound = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

export const notConfigured = (binding: string): Response => refuse(503, 'not_configured', `This pool has no ${binding} binding.`);

export const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined);

export const textField = (value: unknown, key: string): string | undefined => {
  const found = fieldOf(value, key);
  return typeof found === 'string' && found !== '' ? found : undefined;
};

/** A positive whole number from an optional binding; anything else there is the default, so a bad value cannot open a limit. */
export const wholeBinding = (value: string | undefined, fallback: number): number => {
  const whole = Number(bound(value) ?? fallback);
  return Number.isSafeInteger(whole) && whole > 0 ? whole : fallback;
};

/** A body as JSON, or undefined: the route then refuses by the field it needed. A provider's response comes here too, since an outage can answer HTML. */
export const bodyOf = async (message: Request | Response): Promise<unknown> => {
  try {
    return await message.json();
  } catch {
    return undefined;
  }
};
