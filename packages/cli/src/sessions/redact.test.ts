import { describe, expect, it } from 'vitest';
import { makeRedactor } from './redact.js';

// Register row A52: the email mask used to read `bar@1.0.0` after `npm:` or `jsr:` as an address, so a pinned alias lost its pick.
describe('the email mask and a pinned package alias', () => {
  const mask = makeRedactor();

  it('leaves a dotted version after npm: or jsr: alone', () => {
    expect(mask('npm install foo@npm:bar@1.0.0')).toBe('npm install foo@npm:bar@1.0.0');
    expect(mask('npm install npm:@luca/cases@1.0.0')).toBe('npm install npm:@luca/cases@1.0.0');
    expect(mask('pnpm add jsr:@luca/cases@1.0.0')).toBe('pnpm add jsr:@luca/cases@1.0.0');
    expect(mask('pnpm add jsr:cases@1.2.3')).toBe('pnpm add jsr:cases@1.2.3');
  });

  it('still masks a real address on the same line, before or after the alias', () => {
    expect(mask('npm install foo@npm:bar@1.0.0 && mail me@acme.io')).toBe('npm install foo@npm:bar@1.0.0 && mail <email>');
    expect(mask('mail me@acme.io && pnpm add jsr:@luca/cases@1.0.0')).toBe('mail <email> && pnpm add jsr:@luca/cases@1.0.0');
  });

  it('still masks an address after npm: or jsr:, and a version that is not plain digits', () => {
    expect(mask('npm install npm:me@acme.io')).toBe('npm install npm:<email>');
    expect(mask('npm install npm:me@10.0.0.5')).toBe('npm install npm:<email>');
    expect(mask('pnpm add jsr:@luca/me@acme.io')).toBe('pnpm add jsr:@luca/<email>');
    expect(mask('npm install foo@npm:bar@1.0.0-beta.1')).toBe('npm install foo@npm:<email>');
    expect(mask('npm install foo@npm:bar@1.0.0.acme.io')).toBe('npm install foo@npm:<email>');
  });

  it('masks the same version when no npm: or jsr: precedes it', () => {
    expect(mask('contact bar@1.0.0')).toBe('contact <email>');
    expect(mask('npm install bar@1.0.0')).toBe('npm install <email>');
    expect(mask('xnpm:bar@1.0.0')).toBe('xnpm:<email>');
  });
});

// t1559: the EMAIL rule is the backstop for an address the injected-block rule does not reach, so a real address of any script must be masked whole.
describe('the email mask and a non-ASCII or bracketed address', () => {
  const mask = makeRedactor();

  it('masks an internationalized-domain address and its punycode form', () => {
    expect(mask('mail someone@bücher.de now')).toBe('mail <email> now');
    expect(mask('mail someone@xn--bcher-kva.de now')).toBe('mail <email> now');
  });

  it('masks an IP-literal address', () => {
    expect(mask('mail someone@[192.0.2.1] now')).toBe('mail <email> now');
    expect(mask('mail someone@[IPv6:2001:db8::1] now')).toBe('mail <email> now');
  });

  it('leaves a bracketed host that is no IP literal alone', () => {
    expect(mask('see x@[dead] now')).toBe('see x@[dead] now');
  });

  it('masks a non-ASCII local part whole', () => {
    expect(mask('mail jöhn@example.com now')).toBe('mail <email> now');
  });

  it('masks letters that touch an address with no space, with the address', () => {
    expect(mask('連絡先はsomeone@example.com')).toBe('<email>');
  });

  it('leaves a dotless host alone, as in a git remote or ssh target', () => {
    expect(mask('ssh deploy@localhost')).toBe('ssh deploy@localhost');
  });

  it('still keeps a pinned alias', () => {
    expect(mask('npm install foo@npm:bar@1.0.0')).toBe('npm install foo@npm:bar@1.0.0');
  });
});
