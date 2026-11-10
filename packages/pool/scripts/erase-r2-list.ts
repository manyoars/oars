// Listing the telemetry bucket for the erasure. `wrangler` can get, put, and delete an R2 object by key but cannot list a bucket, and the batches' keys are random, so the listing goes through R2's S3 API with an R2 API token the
// operator creates and exports (read on the telemetry bucket is enough). The token is read from the environment by `erase.mjs`, sent only to Cloudflare as a signed request, and never printed or written. The signing is `aws4fetch`
// (as Cloudflare documents for R2) and the answer is parsed by `fast-xml-parser`: neither is written here.
import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';

/** The operator's R2 API token (Cloudflare dashboard, R2, Manage API tokens) and the account it belongs to. */
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type Fetcher = (url: string, init: { headers: { [name: string]: string } }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Reads the listing's fields as text (a key that looks like a number stays the text it is). */
const parser = new XMLParser({ parseTagValue: false, isArray: (name) => name === 'Contents' });

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** The `ListBucketResult` of one page: its keys, and the token of the next page when the listing was truncated. */
const pageOf = (xml: string): { keys: string[]; next: string | undefined; truncated: boolean } => {
  const result = fieldOf(parser.parse(xml), 'ListBucketResult');
  const contents = fieldOf(result, 'Contents');
  const keys = Array.isArray(contents) ? contents.flatMap((one: unknown) => textOf(fieldOf(one, 'Key')) ?? []) : [];
  return { keys, next: textOf(fieldOf(result, 'NextContinuationToken')), truncated: fieldOf(result, 'IsTruncated') === 'true' };
};

/** Every key under the prefix, one `ListObjectsV2` page after another. */
export const r2Lister = (credentials: R2Credentials, bucket: string, fetcher: Fetcher, now: () => Date): ((prefix: string) => Promise<readonly string[]>) => {
  const client = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, service: 's3', region: 'auto' });
  return async (prefix) => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`https://${credentials.accountId}.r2.cloudflarestorage.com/${bucket}`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token !== undefined) url.searchParams.set('continuation-token', token);
      const signed = await client.sign(url.toString(), { method: 'GET', aws: { datetime: now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') } });
      const answer = await fetcher(signed.url, { headers: Object.fromEntries(signed.headers.entries()) });
      if (!answer.ok) throw new Error(`listing ${prefix} answered ${String(answer.status)}`);
      const page = pageOf(await answer.text());
      keys.push(...page.keys);
      token = page.truncated ? page.next : undefined;
      if (page.truncated && (token === undefined || token === '')) throw new Error(`listing ${prefix} was cut short and gave no continuation token`);
    } while (token !== undefined);
    return keys;
  };
};
