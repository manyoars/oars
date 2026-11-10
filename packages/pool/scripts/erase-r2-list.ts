// Listing the telemetry bucket for the erasure. `wrangler` can get, put, and delete an R2 object by key but cannot list a bucket, and the batches' keys are random, so the listing goes through R2's S3 API with an R2 API token the
// operator creates and exports (read on the telemetry bucket is enough). The token is read from the environment by `erase.mjs`, sent only to Cloudflare as a signed request, and never printed or written.
import { createHash, createHmac } from 'node:crypto';

/** The operator's R2 API token (Cloudflare dashboard, R2, Manage API tokens) and the account it belongs to. */
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type Fetcher = (url: string, init: { headers: { [name: string]: string } }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const hmac = (key: string | Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();
const encode = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** What a signature covers. `query` is the raw pairs; `headers` are the signed ones besides `host`, `x-amz-content-sha256`, and `x-amz-date`, which the signer adds. */
export interface SignInput {
  host: string;
  path: string;
  query: readonly (readonly [string, string])[];
  headers?: { [name: string]: string };
  region: string;
  at: Date;
}

/** The headers of an AWS Signature Version 4 GET with an empty body, for the S3 service. */
export const signedGet = (credentials: R2Credentials, input: SignInput): { [name: string]: string } => {
  const stamp = input.at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const payload = sha256('');
  const headers: { [name: string]: string } = { ...input.headers, host: input.host, 'x-amz-content-sha256': payload, 'x-amz-date': stamp };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const canonical = [
    'GET',
    input.path,
    [...input.query].map(([name, value]) => [encode(name), encode(value)] as const).sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))).map(([name, value]) => `${name}=${value}`).join('&'),
    names.map((name) => `${name}:${lowered[name] ?? ''}\n`).join(''),
    names.join(';'),
    payload,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), input.region), 's3'), 'aws4_request');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(key, toSign).toString('hex')}` };
};

const unescaped = (text: string): string => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** Every key under the prefix, one `ListObjectsV2` page after another. */
export const r2Lister = (credentials: R2Credentials, bucket: string, fetcher: Fetcher, now: () => Date): ((prefix: string) => Promise<readonly string[]>) => async (prefix) => {
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const query: (readonly [string, string])[] = [['list-type', '2'], ['prefix', prefix], ...(token === undefined ? [] : [['continuation-token', token] as const])];
    const path = `/${bucket}`;
    const url = `https://${host}${path}?${[...query].map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&')}`;
    const answer = await fetcher(url, { headers: signedGet(credentials, { host, path, query, region: 'auto', at: now() }) });
    if (!answer.ok) throw new Error(`listing ${prefix} answered ${String(answer.status)}`);
    const xml = await answer.text();
    for (const found of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescaped(found[1] ?? ''));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescaped(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : undefined;
    if (token === '') throw new Error(`listing ${prefix} was cut short and gave no continuation token`);
  } while (token !== undefined);
  return keys;
};
