import { describe, expect, it } from 'vitest';
import { PATTERNS, makeRedactor } from './redact.js';
import { pullsOfTool, storedToolName } from './extract.js';

const redact = makeRedactor();

/**
 * Tokens for the pattern rules of `redact.ts`, each with the parts that must never be stored. Nothing here names a rule: the first test
 * asks `PATTERNS` itself, so a rule added there that none of these tokens alone matches fails it, and the samples need no copy of a rule.
 */
const SAMPLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA-----END RSA PRIVATE KEY-----', ['MIIEowIBAAKCAQEA']],
  ['AKIAIOSFODNN7EXAMPLE', ['AKIAIOSFODNN7EXAMPLE']],
  ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', ['abcdefghijklmnopqrstuvwxyz0123456789']],
  ['github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789', ['11ABCDEFG0abcdefghij', 'klmnopqrstuvwxyz0123456789']],
  ['github_pat_AAAAAAAAAA__BBBBBBBBBBBBBBBBBBBB', ['AAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBB']],
  ['sk-proj-AbC1dEfGhIjKlMnOpQrStUvW', ['AbC1dEfGhIjKlMnOpQrStUvW']],
  ['sk-ant-api03-AAAAAAAA_BBBBBBBBBBBB', ['AAAAAAAA', 'BBBBBBBBBBBB']],
  ['sk-AbC1__DeFgHiJkLmNoPqRsTuVw', ['AbC1', 'DeFgHiJkLmNoPqRsTuVw']],
  ['sk-AbC1_DeFgHiJkLmNoPqRsTuVw', ['AbC1', 'DeFgHiJkLmNoPqRsTuVw']],
  ['sk_live_abcdefghijklmnop', ['abcdefghijklmnop']],
  ['pk_test_abcdefghijklmnop', ['abcdefghijklmnop']],
  ['whsec_abcdefghijklmnop', ['abcdefghijklmnop']],
  ['xoxb-1234567890-abcdefghij', ['1234567890', 'abcdefghij']],
  ['AIzaSyA-abcdefghijklmnopqrstuvwxyz0123_45', ['abcdefghijklmnopqrstuvwxyz0123']],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0', 'c2lnbmF0dXJlMTIz']],
  ['eyJhbGciOiJ_IUzI1NiJ9.eyJzdWIiOiIx.c2lnbmF0dXJl', ['eyJhbGciOiJ', 'IUzI1NiJ9', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl']],
  ['Bearer abcdefghijklmnop', ['abcdefghijklmnop']],
  ['https://user:hunter2pass@host', ['hunter2pass']],
  ['DB_PASSWORD=hunter2hunter2', ['hunter2hunter2']],
  ['api_key=abcd1234', ['abcd1234']],
  ['secret_name=abcd1234', ['abcd1234']],
  ['token=ab__cdefgh', ['ab__cdefgh']],
];

/** Whether one rule alone reads the token as a secret. The rules are global regexes, so a fresh copy keeps `lastIndex` out of it. */
const matches = (pattern: RegExp, token: string): boolean => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(token);

/** The names a harness can give a tool, with the token as the server and as the tool, in the `mcp__` form and the Cursor `mcp_` form. */
const namesFor = (token: string): string[] => [
  `mcp__${token}__find`,
  `mcp__me__${token}`,
  `mcp__me__${token}__find`,
  `mcp__me_${token}__find`,
  `mcp_${token}_find`,
  `mcp_me_${token}`,
  `mcp_me_${token}_find`,
];

describe('every pattern rule of the redactor is held back from a stored MCP name', () => {
  it('has a token that only that rule matches for every rule', () => {
    for (const [pattern] of PATTERNS) {
      const own = SAMPLES.filter(([token]) => matches(pattern, token) && PATTERNS.filter(([other]) => matches(other, token)).length === 1);
      expect(own.length, `no sample token for ${pattern.source}`).toBeGreaterThan(0);
    }
  });
  const rows = SAMPLES.flatMap(([token, parts]) => namesFor(token).map((name) => [name, parts] as const));
  it.each(rows)('stores no part of the token in %s', (name, parts) => {
    const stored = JSON.stringify([storedToolName(name, redact), pullsOfTool(name, redact)]);
    for (const part of parts) expect(stored, name).not.toContain(part);
  });
});
