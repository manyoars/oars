// The S3 listing the erasure uses for the telemetry bucket: the signed request, the paging, and the parse.
import { describe, expect, it } from 'vitest';
import { r2Lister, type Fetcher } from './erase-r2-list.js';

const CREDENTIALS = { accountId: 'acct', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('r2Lister', () => {
  const page = (keys: string[], next?: string): string => `<ListBucketResult><IsTruncated>${next === undefined ? 'false' : 'true'}</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}${next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`;

  it('follows the continuation token, signs each request, and decodes the keys', async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (url, init) => {
      urls.push(url);
      expect(init.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261109\/auto\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-date/);
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
    await expect(list(answer(true, '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'))).rejects.toThrow(/no continuation token/);
  });
});
