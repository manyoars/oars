// The S3 listing the erasure uses for the telemetry bucket: the signature against AWS's published example, and the paging.
import { describe, expect, it } from 'vitest';
import { r2Lister, signedGet, type Fetcher } from './erase-r2-list.js';

const CREDENTIALS = { accountId: 'acct', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('signedGet', () => {
  // The "GET Object" example of the AWS Signature Version 4 documentation for S3 (bucket examplebucket, key test.txt, a Range header).
  it('produces the signature AWS documents for its GET Object example', () => {
    const headers = signedGet(CREDENTIALS, { host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: [], headers: { range: 'bytes=0-9' }, region: 'us-east-1', at: new Date('2013-05-24T00:00:00Z') });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('sorts and encodes the query', () => {
    const headers = signedGet(CREDENTIALS, { host: 'h', path: '/b', query: [['prefix', 'a b/'], ['list-type', '2'], ['prefix', "x'"]], region: 'auto', at: new Date('2026-11-09T00:00:00Z') });
    expect(headers['authorization']).toMatch(/Credential=AKIAIOSFODNN7EXAMPLE\/20261109\/auto\/s3\/aws4_request/);
  });
});

describe('r2Lister', () => {
  const page = (keys: string[], next?: string): string => `<ListBucketResult><IsTruncated>${next === undefined ? 'false' : 'true'}</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}${next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`;

  it('follows the continuation token, signs each request, and decodes the keys', async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (url, init) => {
      urls.push(url);
      expect(init.headers['authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(url.includes('continuation-token') ? page(['telemetry/d/b&amp;c.json']) : page(['telemetry/d/a.json'], 'tok/en==')) });
    };
    const keys = await r2Lister(CREDENTIALS, 'oars-telemetry', fetcher, () => new Date('2026-11-09T00:00:00Z'))('telemetry/d/');
    expect(keys).toEqual(['telemetry/d/a.json', 'telemetry/d/b&c.json']);
    expect(urls[0]).toBe('https://acct.r2.cloudflarestorage.com/oars-telemetry?list-type=2&prefix=telemetry%2Fd%2F');
    expect(urls[1]).toBe('https://acct.r2.cloudflarestorage.com/oars-telemetry?list-type=2&prefix=telemetry%2Fd%2F&continuation-token=tok%2Fen%3D%3D');
  });

  it('refuses a listing that answers an error, or is cut short with no token', async () => {
    const answer = (ok: boolean, body: string): Fetcher => () => Promise.resolve({ ok, status: ok ? 200 : 403, text: () => Promise.resolve(body) });
    const list = (fetcher: Fetcher): Promise<readonly string[]> => r2Lister(CREDENTIALS, 'b', fetcher, () => new Date('2026-11-09T00:00:00Z'))('p/');
    await expect(list(answer(false, ''))).rejects.toThrow(/answered 403/);
    await expect(list(answer(true, '<IsTruncated>true</IsTruncated>'))).rejects.toThrow(/no continuation token/);
  });
});
