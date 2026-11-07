// The redactor over a whole transcript body (t884 Item 1): one canary per class, none surviving, and the count of what was masked.
import { describe, expect, it } from 'vitest';
import { redactTranscript } from './redact.js';

const CANARIES: ReadonlyArray<readonly [string, string]> = [
  ['a GitHub token', 'ghp_Canary1234567890abcdefghijklmnop'],
  ['an AWS key id', 'AKIACANARY0123456789'],
  ['a bearer credential', 'Bearer canaryBearer0123456789abcdef'],
  ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nCANARYKEYBODY\n-----END RSA PRIVATE KEY-----'],
  ['a password in a URL', 'postgres://canaryuser:canarypass@db.canary-internal.example:5432/app'],
  ['a named secret', 'API_KEY=canarysecretvalue99'],
  ['an email', 'canary.person@canary-mail.example'],
  ['a unix home path', '/home/canaryuser/work/app/src/index.ts'],
  ['a macOS home path', '/Users/canaryuser/work/app'],
  ['a Windows home path', 'C:\\\\Users\\\\canaryuser\\\\work\\\\app'],
  ['an environment value', 'export CANARY_REGION=canary-east-1'],
  ['an internal host in a URL', 'curl https://build.canary-corp.example/v1/status'],
  ['an internal host name', 'ssh canary-box.corp.internal'],
  ['an IPv4 address', 'connect 10.77.88.99 failed'],
  ['an organization domain', 'see wiki.canary-org.test for details'],
];
const LEAKS: ReadonlyArray<readonly [string, string]> = [
  ['a GitHub token', 'Canary1234567890abcdefghijklmnop'],
  ['an AWS key id', 'CANARY0123456789'],
  ['a bearer credential', 'canaryBearer0123456789abcdef'],
  ['a private key', 'CANARYKEYBODY'],
  ['a password in a URL', 'canarypass'],
  ['a named secret', 'canarysecretvalue99'],
  ['an email', 'canary-mail'],
  ['a unix home path', 'canaryuser'],
  ['a macOS home path', 'canaryuser'],
  ['a Windows home path', 'canaryuser'],
  ['an environment value', 'canary-east-1'],
  ['an internal host in a URL', 'canary-corp'],
  ['an internal host name', 'canary-box'],
  ['an IPv4 address', '10.77.88.99'],
  ['an organization domain', 'canary-org'],
];

describe('redactTranscript', () => {
  it.each(CANARIES.map((canary, at) => [canary[0], canary[1], LEAKS[at]?.[1] ?? ''] as const))('leaves nothing of %s', (_name, canary, leak) => {
    const body = `${JSON.stringify({ type: 'user', message: { content: `before ${canary} after` } })}\n`;
    const { text } = redactTranscript(body, ['canary-org.test']);
    expect(text).not.toContain(leak);
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('keeps the JSON lines of a transcript parseable and counts what it masked', () => {
    const lines = CANARIES.map(([, canary]) => JSON.stringify({ type: 'user', message: { content: canary } }));
    const { text, masked } = redactTranscript(`${lines.join('\n')}\n`, ['canary-org.test']);
    for (const line of text.split('\n').filter((entry) => entry !== '')) expect(() => { JSON.parse(line); }).not.toThrow();
    expect(masked).toBeGreaterThanOrEqual(CANARIES.length);
  });

  it('counts nothing for a transcript with nothing to mask', () => {
    expect(redactTranscript('{"type":"user","message":{"content":"hello"}}\n', [])).toEqual({ text: '{"type":"user","message":{"content":"hello"}}\n', masked: 0 });
  });
});
