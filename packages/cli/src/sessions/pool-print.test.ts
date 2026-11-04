import { describe, expect, it } from 'vitest';
import { Masker, maskOf, printed, waitWords, type Outgoing } from './pool-print.js';

const NOW = Date.parse('2026-11-04T00:00:00Z');

describe('maskOf and Masker', () => {
  it('says only how many bytes the credential has, counting bytes and not characters', () => {
    expect(maskOf('abc')).toBe('<credential: 3 bytes>');
    expect(maskOf('é')).toBe('<credential: 2 bytes>');
  });

  it('masks a secret wherever it is written, and every one added', () => {
    const masker = new Masker();
    masker.add('s3cret value/+=');
    masker.add('');
    masker.add('tok');
    const form = new URLSearchParams({ device_code: 's3cret value/+=' }).toString();
    const text = `a: s3cret value/+=\nb: ${form}\nc: ${encodeURIComponent('s3cret value/+=')}\nd: ${JSON.stringify({ k: 's3cret value/+=' })}\ne: tok`;
    const masked = masker.mask(text);
    expect(masked).not.toContain('s3cret');
    expect(masked).not.toContain('tok');
    expect(masked).toContain('device_code=<credential: 15 bytes>');
    expect(masked).toContain('{"k":"<credential: 15 bytes>"}');
    expect(masked.split('<credential: 3 bytes>')).toHaveLength(2);
  });

  it('masks the JSON-escaped spelling of a secret that holds a quote or a backslash', () => {
    const masker = new Masker();
    masker.add('a"b\\c');
    expect(masker.mask(JSON.stringify({ token: 'a"b\\c' }))).toBe('{"token":"<credential: 5 bytes>"}');
  });

  it('replaces a secret that holds another whole, longest first', () => {
    const masker = new Masker();
    masker.add('abcdefgh');
    masker.add('abcd');
    expect(masker.mask('x abcdefgh y')).toBe('x <credential: 8 bytes> y');
  });
});

describe('printed', () => {
  const get: Outgoing = { method: 'GET', url: new URL('https://pool.test/bundle/2.1.314/0?x=1'), headers: [['authorization', 'Bearer tok-123456']] };

  it('prints the request line, host, connection, and each header, with no body for a GET', () => {
    const masker = new Masker();
    masker.add('tok-123456');
    expect(printed(get, masker)).toBe('GET /bundle/2.1.314/0?x=1 HTTP/1.1\nhost: pool.test\nconnection: keep-alive\nauthorization: Bearer <credential: 10 bytes>\n');
  });

  it('prints a body after a blank line with its length, masked', () => {
    const masker = new Masker();
    masker.add('tok-123456');
    const post: Outgoing = { method: 'POST', url: new URL('https://pool.test/v1/login'), headers: [], body: '{"token":"tok-123456"}' };
    expect(printed(post, masker)).toBe('POST /v1/login HTTP/1.1\nhost: pool.test\nconnection: keep-alive\ncontent-length: 22\n\n{"token":"<credential: 10 bytes>"}\n');
  });
});

describe('waitWords', () => {
  it.each([
    ['345600', 'in 4 days'],
    ['93600', 'in 1 day and 2 hours'],
    ['93660', 'in 1 day and 3 hours'],
    ['172740', 'in 2 days'],
    ['3660', 'in 1 hour and 1 minute'],
    ['3601', 'in 1 hour and 1 minute'],
    ['3599', 'in 1 hour'],
    ['90', 'in 2 minutes'],
    ['45', 'in 45 seconds'],
    ['1', 'in 1 second'],
    ['0', 'now'],
  ])('%s seconds is %s', (seconds, words) => {
    expect(waitWords(seconds, NOW)).toBe(words);
  });

  it('reads an HTTP date against the clock, and a date already past as now', () => {
    expect(waitWords(new Date(NOW + 2 * 86_400_000).toUTCString(), NOW)).toBe('in 2 days');
    expect(waitWords(new Date(NOW - 5000).toUTCString(), NOW)).toBe('now');
  });

  it('says nothing for what is neither', () => {
    expect(waitWords('soon', NOW)).toBeUndefined();
  });
});
