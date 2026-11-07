// The config is public and the first deploy belongs to the account holder, so it may name no account, resource, secret, route, or domain.
import { describe, expect, it } from 'vitest';
import { fieldOf, wranglerConfig } from './test-pool.js';

describe('wrangler.jsonc', () => {
  const { parsed, text } = wranglerConfig();

  it('commits no account id, route, custom domain, or plain variable but the two public floors', () => {
    for (const key of ['account_id', 'route', 'routes', 'workers_dev', 'env', 'preview_urls']) expect(fieldOf(parsed, key), key).toBeUndefined();
    // A floor is public by design (it is stated in every bundle), so it is a plain variable; `floors.test.ts` holds these to the defaults in the code.
    expect(Object.keys(fieldOf(parsed, 'vars') ?? {}).sort()).toEqual(['DISCLOSURE_FLOOR', 'PUBLIC_FLOOR']);
    expect(text).not.toMatch(/manyoars\.com|\.workers\.dev/);
  });

  it('binds its one database by name, with no resource id', () => {
    const databases = fieldOf(parsed, 'd1_databases');
    expect(databases).toEqual([{ binding: 'DB', database_name: 'oars-pool', migrations_dir: 'migrations' }]);
  });

  it('binds the raw tier, the telemetry record, and the index by name, with no account or resource id', () => {
    expect(fieldOf(parsed, 'r2_buckets')).toEqual([
      { binding: 'RAW', bucket_name: 'oars-pool-raw' },
      { binding: 'TELEMETRY', bucket_name: 'oars-telemetry' }
    ]);
    expect(fieldOf(parsed, 'analytics_engine_datasets')).toEqual([{ binding: 'TELEMETRY_EVENTS', dataset: 'oars_telemetry' }]);
  });

  it('holds nothing shaped like an id or a key', () => {
    expect(text).not.toMatch(/[0-9a-f]{32}/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it('names no secret: the signing key, OAuth values, and covenant version are bindings the deploy sets', () => {
    for (const binding of ['BUNDLE_SIGNING_KEY', 'PSEUDONYM_KEY', 'GITHUB_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'COVENANT_VERSION']) expect(text).not.toContain(binding);
  });
});
