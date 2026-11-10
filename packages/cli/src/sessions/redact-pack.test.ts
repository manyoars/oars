// t1111 Item 3: what the sample pack's redaction stops over-masking, and the secret shapes it now catches. Every value is invented.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeRedactor, redactTranscript } from './redact.js';

const line = (value: object): string => JSON.stringify(value);
const keyed = (id: string): string => `toolu_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const CALL = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
const call = (name: string, input: object, id = CALL): string =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (text: string, id = CALL): string =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

describe('tool use ids', () => {
  it('keys a call id and its result id to one value when the pack gives a key function', () => {
    const body = [call('Bash', { command: 'ls' }), result('ok')].join('\n');
    const { text } = redactTranscript(body, [], [], 'k', { toolId: keyed });
    const ids = [...text.matchAll(/toolu_[0-9a-f]{24}/g)].map((match) => match[0]);
    expect(ids).toEqual([keyed(CALL), keyed(CALL)]);
    expect(text).not.toContain(CALL);
  });

  it('keeps masking a tool id as a secret when no key function is given', () => {
    const { text } = redactTranscript([call('Bash', { command: 'ls' }), result('ok')].join('\n'), [], [], 'k');
    expect(text).not.toContain(CALL);
    expect(text).toContain('<secret>');
  });

  it('keys server tool and cloud-prefixed ids too, inside prose', () => {
    const { text } = redactTranscript(`ids srvtoolu_01AbCdEfGhIjKlMnOpQr and toolu_bdrk_01AbCdEfGhIjKlMnOpQr here`, [], [], 'k', { toolId: (id) => `mapped(${String(id.length)})` });
    expect(text).toBe('ids mapped(29) and mapped(31) here');
  });
});

describe('numbers and names that are not secrets', () => {
  const redact = makeRedactor();
  it('keeps a count under a token name, as frontmatter, JSON text, and a flag', () => {
    expect(redact('---\ntokens: 12345\n---')).toBe('---\ntokens: 12345\n---');
    expect(redact('  "inputTokens": 123456,')).toBe('  "inputTokens": 123456,');
    expect(redact('{"cache_read_tokens":"98765"}')).toBe('{"cache_read_tokens":"98765"}');
    expect(redact('max_tokens=4096')).toBe('max_tokens=4096');
  });

  it('still masks a token name with a real value, and a number under a name that is always a secret', () => {
    expect(redact('tokens: abcd1234efgh')).toBe('tokens: <secret>');
    expect(redact('token=12345abc')).toBe('token=<secret>');
    expect(redact('token=123456')).toBe('token=<secret>');
    expect(redact('{"verify_token": "839201"}')).toBe('{"verify_token": "<secret>"}');
    expect(redact('AUTH_TOKEN=1234567890')).toBe('AUTH_TOKEN=<secret>');
    expect(redact('api_key: 12345678')).toBe('api_key: <secret>');
    expect(redact('password=123456')).toBe('password=<secret>');
  });

  it('does not read a scoped npm package with a version as an email', () => {
    expect(redact('installed @scope/name@1.2.3 and @babel/preset-env@7.2.0')).toBe('installed @scope/name@1.2.3 and @babel/preset-env@7.2.0');
    expect(redact('mail jane@example.com and user@1.2.3')).toBe('mail <email> and <email>');
  });

  it('does not read a vendor name before a colon as a secret key', () => {
    expect(redact('1password: a password manager')).toBe('1password: a password manager');
    expect(redact('password: hunter2xx')).toBe('password: <secret>');
    expect(redact('x-1password: hunter2xx')).toBe('x-1password: <secret>');
    expect(redact('1password=hunter2xx')).toBe('1password=<secret>');
  });
});

describe('token-shaped fixtures', () => {
  const redact = makeRedactor();
  it('masks a synthetic GitHub, Stripe, or Slack token as it does a real one, short or stuck to a prefix', () => {
    for (const fake of ['ghp_abcdefgh1234', 'FAKE_ghp_abcdefghij1234', 'github_pat_abcdefgh12', 'sk_test_abcdefgh', 'TEST_sk_live_abcdefgh', 'rk_test_abcdefgh', 'whsec_abcdefgh', 'xoxb-1234567', 'xoxp-fake-token']) {
      // The prefix before the token's own (`FAKE_`) is not part of it.
      expect(redact(`use ${fake} here`), fake).toMatch(/^use (?:FAKE_|TEST_)?<secret> here$/);
    }
  });

  it('leaves look-alikes alone', () => {
    const text = 'task_test_list mask_test_abcdefgh ghp_ sk_test_ xoxb-12 a ghost_abcdefgh1234';
    expect(redact(text)).toBe(text);
  });
});

describe('hosts the session itself fetched', () => {
  const body = [
    call('WebFetch', { url: 'https://docs.example.org/page', prompt: 'summarize' }),
    result('See https://docs.example.org/guide, https://other.example.net/x, http://localhost:3000/a, and https://tools.corp.local/b.'),
  ].join('\n');
  const seen = (text: string): string => JSON.stringify(text);

  it('keeps a fetched public host in that call result and masks every other host', () => {
    const { text } = redactTranscript(body, [], [], 'k', { fetchedHosts: true });
    expect(seen(text)).toContain('https://docs.example.org/guide');
    expect(seen(text)).toContain('https://<host>/x');
    expect(seen(text)).toContain('http://<host>/a');
    expect(seen(text)).toContain('https://<host>/b');
  });

  it('masks every host when the option is off', () => {
    const { text } = redactTranscript(body, [], [], 'k');
    expect(text).not.toContain('docs.example.org');
  });

  it('never keeps an organization domain a fetch named: the operator set masks it before the fetched-host rule runs', () => {
    const lines = [call('WebFetch', { url: 'https://wiki.example.org/page' }, 'toolu_01OrgOrgOrgOrgOrgOr04'), result('see https://wiki.example.org/page and https://docs.example.net/x', 'toolu_01OrgOrgOrgOrgOrgOr04')];
    const { text } = redactTranscript(lines.join('\n'), ['example.org'], [], 'k', { fetchedHosts: true });
    expect(text).not.toContain('example.org');
    expect(text).toContain('<org-domain>');
  });

  it('keeps a fetched host in that call result only: a plain-text line or a top-level array after it gets none', () => {
    const lines = [call('WebFetch', { url: 'https://docs.example.org/page' }, 'toolu_01KeptKeptKeptKept05'), result('see https://docs.example.org/guide', 'toolu_01KeptKeptKeptKept05'), 'plain line at https://docs.example.org/guide', '["https://docs.example.org/guide"]'];
    const rows = redactTranscript(lines.join('\n'), [], [], 'k', { fetchedHosts: true }).text.split('\n');
    expect(rows[1]).toContain('https://docs.example.org/guide');
    expect(rows[2]).toBe('plain line at https://<host>/guide');
    expect(rows[3]).toBe('["https://<host>/guide"]');
  });

  it('keeps a searched domain, but never a loopback, private-range, or .local host, and never in another call result', () => {
    const lines = [
      call('WebSearch', { query: 'redaction', allowed_domains: ['news.example.org', 'localhost', 'wiki.corp.local'] }, 'toolu_01SearchSearchSearch01'),
      result('hits: https://news.example.org/a http://localhost/b https://wiki.corp.local/c', 'toolu_01SearchSearchSearch01'),
      call('WebFetch', { url: 'http://192.168.1.5:8080/x' }, 'toolu_01FetchFetchFetchFe02'),
      result('from http://192.168.1.5:8080/x and https://news.example.org/a', 'toolu_01FetchFetchFetchFe02'),
      result('elsewhere https://news.example.org/a', 'toolu_01OtherOtherOtherOt03'),
    ];
    const rows = redactTranscript(lines.join('\n'), [], [], 'k', { fetchedHosts: true }).text.split('\n');
    expect(rows[1]).toContain('https://news.example.org/a');
    expect(rows[1]).toContain('http://<host>/b');
    expect(rows[1]).toContain('https://<host>/c');
    expect(rows[3]).toContain('http://<host>/x');
    expect(rows[3]).not.toContain('news.example.org');
    expect(rows[4]).not.toContain('news.example.org');
  });
});
