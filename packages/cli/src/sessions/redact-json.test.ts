// The raw copy is JSONL, so every tool output is a JSON string: a newline is the two characters `\n` and a quote is `\"` (t955; census
// section 3, rows S1, S2, S3, S22). Each shape of the census table runs plain and as the second line of a `tool_result`, the on-disk form,
// and no fake value may survive in either. Fixtures are constructions from a seeded generator, never a literal secret.
import { describe, expect, it } from 'vitest';
import { redactTranscript } from './redact.js';

const rng = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = (alphabet: string, length: number, seed: number): string => {
  const next = rng(seed);
  return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)] ?? '').join('');
};
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const B62 = (length: number, seed: number): string => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', length, seed);
const B32 = (length: number, seed: number): string => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', length, seed);
const HEX = (length: number, seed: number): string => pick('0123456789abcdef', length, seed);

const AWS_SECRET = `${B62(12, 1)}/${B62(8, 2)}+${B62(16, 3)}/${B62(1, 4)}`;
const SESSION_TOKEN = `IQoJb3JpZ2luX2Vj${Array.from({ length: 12 }, (_, at) => B62(4, 20 + at)).join('/')}`;
const AKIA = `AKIA${B32(16, 5)}`;
const PGP_BODY = [B62(64, 6), B62(64, 7)];
const PUTTY_PRIVATE = B62(44, 8);

interface Shape {
  readonly name: string;
  readonly text: string;
  readonly leaks: readonly string[];
}

const SHAPES: readonly Shape[] = [
  { name: 'a JSON "password" pair', text: '{"password": "hunter2pass"}', leaks: ['hunter2pass'] },
  { name: 'a SecretAccessKey pair', text: `{"SecretAccessKey": "${AWS_SECRET}"}`, leaks: [AWS_SECRET] },
  { name: 'a SessionToken pair', text: `{"SessionToken": "${SESSION_TOKEN}"}`, leaks: [SESSION_TOKEN] },
  { name: 'an AWS key id', text: AKIA, leaks: [AKIA] },
  { name: 'an IPv4 address', text: '10.1.2.3 db', leaks: ['10.1.2.3'] },
  { name: 'a bare AWS secret key', text: AWS_SECRET, leaks: [AWS_SECRET] },
  { name: 'a PGP private key block', text: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${PGP_BODY.join('\n')}\n-----END PGP PRIVATE KEY BLOCK-----`, leaks: PGP_BODY },
  {
    name: 'a PuTTY key file',
    text: `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: key\nPublic-Lines: 1\n${B62(44, 9)}\nPrivate-Lines: 1\n${PUTTY_PRIVATE}\nPrivate-MAC: ${HEX(64, 10)}`,
    leaks: [PUTTY_PRIVATE],
  },
  { name: 'curl -u user:password', text: 'curl -u admin:hunter2pass https://api.example.com/v1', leaks: ['hunter2pass'] },
  { name: 'mysql -p<password>', text: 'mysql -padmin123secret -h db', leaks: ['admin123secret'] },
  { name: 'psql -W with a quoted password', text: "psql -W 'hunter2pass' app", leaks: ['hunter2pass'] },
  { name: '--password with a space', text: 'deploy --password swordfish99 --force', leaks: ['swordfish99'] },
  { name: 'a lower-case .env name', text: 'mapbox=q8z7x6c5v4b3n2m1', leaks: ['q8z7x6c5v4b3n2m1'] },
  { name: 'SMTP_PASS=', text: 'SMTP_PASS=Summer2026!', leaks: ['Summer2026!'] },
  { name: 'ADMIN_PIN=', text: 'ADMIN_PIN=482913', leaks: ['482913'] },
  { name: 'DB_HOST_KEY=', text: 'DB_HOST_KEY=abcd1234', leaks: ['abcd1234'] },
  { name: 'MAPBOX_SK=', text: 'MAPBOX_SK=q8z7x6c5v4b3n2m1', leaks: ['q8z7x6c5v4b3n2m1'] },
  { name: 'a DigitalOcean token', text: `dop_v1_${HEX(64, 13)}`, leaks: [HEX(64, 13)] },
  { name: 'curl -u attached to its user', text: 'curl -uadmin:hunter2pass https://api.example.com/v1', leaks: ['hunter2pass'] },
  { name: "mysql -p'<password>'", text: "mysql -u root -p'P@ssw0rd!9x' db", leaks: ['P@ssw0rd!9x'] },
  { name: 'mysql -p"<password>"', text: 'mysql -u root -p"P@ssw0rd!9y" db', leaks: ['P@ssw0rd!9y'] },
  { name: 'a lower-case GitHub token', text: `ghp_${pick(LOWER, 36, 11)}`, leaks: [pick(LOWER, 36, 11)] },
  { name: 'a lower-case Slack token', text: `xoxb-1234567890-${pick(LOWER, 24, 12)}`, leaks: [pick(LOWER, 24, 12)] },
];

const jsonl = (text: string): string => `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `line one\n${text}` }] } })}\n`;
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);

describe('the raw copy over the census shape table', () => {
  describe.each(SHAPES)('$name', ({ text, leaks }) => {
    it('is masked in plain text', () => {
      const { text: out } = redactTranscript(`${text}\n`, []);
      for (const leak of leaks) expect(out).not.toContain(leak);
    });

    it('is masked as the second line of a JSON-encoded tool_result, plain or escaped', () => {
      const { text: out, masked } = redactTranscript(jsonl(text), []);
      for (const leak of leaks) {
        expect(out).not.toContain(leak);
        expect(out).not.toContain(escaped(leak));
      }
      expect(masked).toBeGreaterThan(0);
      for (const line of out.split('\n').filter((entry) => entry !== '')) expect(() => { JSON.parse(line); }).not.toThrow();
      expect(JSON.stringify(JSON.parse(out.trim()))).toContain('line one\\n');
    });
  });
});

const hasContent = (value: unknown): value is { content: string } => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'content') === 'string';

describe('the decoded-value rule', () => {
  it('keeps the exact bytes of a line it does not change, escapes and spacing included', () => {
    const bs = String.fromCharCode(92);
    const line = `{ "a" : "caf${bs}u00e9 ${bs}/ <b>${bs}n", "usage":{"input_tokens":12345,"max_tokens":4096},  "n": 1.0 }`;
    const body = `${line}\n\n${line}\r\n`;
    expect(redactTranscript(body, [])).toEqual({ text: body, masked: 0 });
  });

  it('changes only the line that holds a secret and keeps the lines around it as they were', () => {
    const quiet = '{ "a" : "plain \u00e9" }';
    const loud = JSON.stringify({ text: `ok\nAKIA${B32(16, 40)}` });
    const { text } = redactTranscript(`${quiet}\n${loud}\n${quiet}\n`, []);
    const lines = text.split('\n');
    expect([lines[0], lines[2], lines[3]]).toEqual([quiet, quiet, '']);
    expect(JSON.parse(lines[1] ?? '')).toEqual({ text: 'ok\n<secret>' });
  });

  it('keeps a line ending with a carriage return when it re-serializes', () => {
    const body = `${JSON.stringify({ text: `x\nAKIA${B32(16, 41)}` })}\r\n`;
    expect(redactTranscript(body, []).text).toBe(`${JSON.stringify({ text: 'x\n<secret>' })}\r\n`);
  });

  it('walks a string that holds a JSON object or array, however deep', () => {
    const inner = JSON.stringify({ SecretAccessKey: AWS_SECRET, nested: JSON.stringify([{ password: 'hunter2pass' }]) });
    const { text } = redactTranscript(`${JSON.stringify({ content: inner })}\n`, []);
    expect(text).not.toContain('hunter2pass');
    expect(text).not.toContain(AWS_SECRET);
    const outer: unknown = JSON.parse(text.trim());
    if (!hasContent(outer)) throw new Error('no content');
    const content = outer.content;
    expect(JSON.parse(content)).toEqual({ SecretAccessKey: '<secret>', nested: '[{"password":"<secret>"}]' });
  });

  it('masks a secret-named value in an array and a number under a password name, but not a count of tokens', () => {
    const line = JSON.stringify({ api_keys: ['abcd1234', 'x'], password: 12345678, input_tokens: 4096, tokens: 99999 });
    expect(JSON.parse(redactTranscript(`${line}\n`, []).text)).toEqual({ api_keys: ['<secret>', 'x'], password: '<secret>', input_tokens: 4096, tokens: 99999 });
  });

  it('masks a secret that is a key, and a pair inside prose that holds JSON', () => {
    const line = JSON.stringify({ [`ops@acme${B32(3, 42)}.io`]: 1, out: 'Result: {"SessionToken": "abc/def+ghi1234="} done' });
    const { text } = redactTranscript(`${line}\n`, []);
    expect(text).not.toContain('ops@acme');
    expect(text).not.toContain('abc/def');
  });

  it('is valid JSON afterward when a rule used to eat the n of a newline', () => {
    const token = `${B62(10, 43)}q8z7x6c5v4b3n2m1`;
    const line = JSON.stringify({ out: `first\nMAPBOX_SK=${token}\nlast` });
    const { text } = redactTranscript(`${line}\n`, []);
    expect(JSON.parse(text.trim())).toEqual({ out: 'first\n<secret>\nlast' });
  });

  it('keeps today\'s text path for a line that does not parse, and for plain lines between JSON lines', () => {
    const body = `plain one\n{"a": truncated\nSMTP_PASS=Summer2026!\n${JSON.stringify({ t: 'x' })}\nmapbox=q8z7x6c5v4b3n2m1\n`;
    expect(redactTranscript(body, []).text).toBe(`plain one\n{"a": truncated\nSMTP_PASS=<env>\n${JSON.stringify({ t: 'x' })}\nmapbox=<env>\n`);
  });

  it('reads one pretty-printed document as a document', () => {
    const body = JSON.stringify({ messages: [{ text: `AKIA${B32(16, 44)}` }] }, null, 2);
    expect(JSON.parse(redactTranscript(body, []).text)).toEqual({ messages: [{ text: '<secret>' }] });
  });

  it('masks the local name inside a decoded value and a Windows path with single backslashes', () => {
    const line = JSON.stringify({ cwd: String.raw`C:\Users\canaryuser\work`, text: 'ask canaryuser' });
    expect(JSON.parse(redactTranscript(`${line}\n`, [], ['canaryuser']).text)).toEqual({ cwd: String.raw`C:\Users\<user>\work`, text: 'ask <user>' });
  });
});

describe('what the new rules leave alone', () => {
  const kept = [
    ['a git sha', `commit ${HEX(40, 50)} Merge`],
    ['the cut front of a base64 image', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf...'],
    ['a repetitive base64 run', 'AAAAAAAAAAAAAAAA+AAAAAAAAAAAAAAAA/AAAAAAA'],
    ['a 40-character path with no digit', 'src/sessions/pool-command/helpers/some-folder/x'],
    ['a port flag', 'docker run -p 8080:80 nginx and mkdir -p build2024 and ssh -W host:22 jump'],
    ['an attached port flag', 'docker run -p3000:3000/tcp -p127.0.0.1:80:80 nginx'],
    ['a compiler flag', 'gcc -pthread -pedantic -Wall -Werror main.c'],
    ['a uid:gid user', 'docker run -u 1000:1000 alpine'],
    ['an attached uid:gid user', 'docker run -u1000:1000 alpine'],
    ['a PGP public key block', `-----BEGIN PGP PUBLIC KEY BLOCK-----
Comment: a public key is meant to be shared
-----END PGP PUBLIC KEY BLOCK-----`],
    ['a prose mention of a PuTTY key file header', 'PuTTY-User-Key-File-3: is the header line; it is followed by Encryption and Comment'],
    ['a flag', 'curl --user-agent x --password-stdin -s url, make --pass-through=1'],
    ['a lower-case assignment inside a line', 'run --out=build2024 then ?page=2&sort=name'],
  ] as const;
  it.each(kept)('keeps %s unmasked', (_name, text) => {
    expect(redactTranscript(`${text}\n`, []).text).toBe(`${text}\n`);
    expect(redactTranscript(jsonl(text), []).text).toBe(jsonl(text));
  });
});
