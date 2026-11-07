// The redactor over a whole transcript body (t884 Item 1): one canary per class, none surviving, and the count of what was masked.
import { describe, expect, it } from 'vitest';
import { localNames, redactTranscript } from './redact.js';

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
  ['an IPv6 address', 'connect fd00::1234:5678 failed'],
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
  ['an IPv6 address', '1234:5678'],
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

  // The harness's encoded project folders and a shell prompt hold the local username all the time (fix round 2, Item 13).
  const FORMS: ReadonlyArray<readonly [string, string]> = [
    ['an encoded macOS or Linux project folder', '/home/x/.claude/projects/-Users-canaryuser-work-app/abc.jsonl'],
    ['an encoded Windows project folder', 'C--Users-canaryuser-work-app'],
    ['an encoded home project folder', '-home-canaryuser-work-app'],
    ['a shell prompt', 'canaryuser@canarybox:~/work$ ls'],
    ['a bare mention', 'ask canaryuser to review'],
  ];
  it.each(FORMS)('masks the local username in %s', (_name, form) => {
    const { text, masked } = redactTranscript(`${JSON.stringify({ type: 'user', message: { content: form } })}\n`, [], ['canaryuser']);
    expect(text).not.toContain('canaryuser');
    expect(text).not.toContain('canarybox');
    expect(masked).toBeGreaterThan(0);
  });

  it('keeps the rest of an encoded project folder and masks only the name', () => {
    expect(redactTranscript('-Users-canaryuser-work-app', []).text).toBe('-Users-<user>-work-app');
    expect(redactTranscript('C--Users-canaryuser-work', []).text).toBe('C--Users-<user>-work');
    expect(redactTranscript('see foo-Users-bar here', []).text).toBe('see foo-Users-bar here');
  });

  // The name rule runs before the path rules, so a hyphenated or spaced name is masked whole (fix round 3, Item 17).
  it.each([
    ['a hyphenated name in an encoded Windows folder', 'C--Users-mary-jane-work', ['mary-jane'], 'C--Users-<user>-work'],
    ['a spaced name in a Windows path', String.raw`C:\Users\John Smith\repo`, ['John Smith'], String.raw`C:\Users\<user>\repo`],
    ['a spaced name in an encoded Windows folder', 'C--Users-John-Smith-repo', ['John Smith'], 'C--Users-<user>-repo'],
    ['a hyphenated name in a unix path', '/home/mary-jane/work', ['mary-jane'], '/home/<user>/work'],
  ])('masks the whole of %s', (_label, input, names, expected) => {
    expect(redactTranscript(input, [], names).text).toBe(expected);
  });

  it('masks the longer of two overlapping names whole', () => {
    expect(redactTranscript('/home/mary-jane/x and mary', [], ['mary', 'mary-jane']).text).toBe('/home/<user>/x and <user>');
  });

  it('masks a name only as a whole word, and ignores one too short to mean anything', () => {
    expect(redactTranscript('canaryusers and canaryuser.', [], ['canaryuser']).text).toBe('canaryusers and <user>.');
    expect(redactTranscript('a b ab', [], ['a', 'ab']).text).toBe('a b ab');
  });

  it('reads the local names from the account and the home folder', () => {
    const names = localNames('/home/someone-else');
    expect(names).toContain('someone-else');
    expect(names.every((name) => name.length >= 3)).toBe(true);
  });

  it('keeps clock times and compressed words that are not addresses', () => {
    expect(redactTranscript('at 10:20:30 and 12:34:56.789 std::string', []).text).toBe('at 10:20:30 and 12:34:56.789 std::string');
  });

  it('masks the loopback and compressed IPv6 forms', () => {
    for (const address of ['::1', 'fe80::', '2001:db8::ff00:42:8329', '2001:0db8:0000:0000:0000:ff00:0042:8329']) expect(redactTranscript(`host ${address} up`, []).text).toBe('host <host> up');
  });
});
