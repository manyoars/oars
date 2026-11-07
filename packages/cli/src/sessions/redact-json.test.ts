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
