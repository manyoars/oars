import { describe, expect, it } from 'vitest';
import { describePage, step } from './live-page.js';

describe('describePage', () => {
  it('names the title and the URL path only', () => {
    const named = describePage('Terms and Conditions', 'http://localhost:8180/realms/aor/login-actions/required-action?execution=TERMS&session_code=abc&user_code=ABCD-EFGH#frag');
    expect(named).toBe('page "Terms and Conditions" at /realms/aor/login-actions/required-action');
    expect(named).not.toMatch(/session_code|user_code|execution|ABCD|frag/);
  });

  it('does not throw on a URL it cannot parse', () => {
    expect(describePage('', 'about:blank?x=1')).toBe('page "" at blank');
    expect(describePage('Blank', 'not a url?secret=1')).toBe('page "Blank" at (unparsable URL)');
  });
});

const failureOf = async (outcome: Promise<void>): Promise<Error> => {
  try {
    await outcome;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('The step did not reject.');
};

describe('step', () => {
  const page = { title: () => Promise.resolve('Sign in'), url: () => 'http://x/realms/aor?user_code=ABCD' };

  it('keeps the Playwright call log, with the device code and typed values, out of the thrown error', async () => {
    const callLog = ['Timeout 30000ms exceeded.', 'Call log:', '  - navigating to "http://x/device?user_code=ABCD"', '  - fill("secret")'];
    const failure = new Error(callLog.join(String.fromCharCode(10)));
    failure.name = 'TimeoutError';
    const thrown = await failureOf(step(page, 'sign in', () => Promise.reject(failure)));
    expect(thrown.cause).toBeUndefined();
    expect(thrown.message).not.toMatch(/ABCD|secret|navigating|fill\(/);
    // message, stack, and cause are non-enumerable own properties, so Object.values would miss a copied stack.
    expect(Object.getOwnPropertyNames(thrown).map((name) => String(Reflect.get(thrown, name))).join(' ')).not.toMatch(/ABCD|secret|navigating|fill\(/);
    expect(thrown.message).toBe('The device approval stopped at "sign in" on page "Sign in" at /realms/aor (TimeoutError).');
  });

  it('names a rejection that is not an Error', async () => {
    const foreign = new Error('secret');
    Object.setPrototypeOf(foreign, null);
    const thrown = await failureOf(step(page, 'open', () => Promise.reject(foreign)));
    expect(thrown.message).toBe('The device approval stopped at "open" on page "Sign in" at /realms/aor (Error).');
  });

  it('passes a successful action through', async () => {
    await expect(step(page, 'ok', () => Promise.resolve())).resolves.toBeUndefined();
  });

  it('survives a title lookup that fails', async () => {
    const closed = { title: () => Promise.reject(new Error('closed')), url: () => 'http://x/a' };
    const thrown = await failureOf(step(closed, 'x', () => Promise.reject(new Error('e'))));
    expect(thrown.message).toContain('page "" at /a');
  });
});
