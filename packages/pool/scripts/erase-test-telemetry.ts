// The telemetry bucket as the erasure tests reach it: a Miniflare binding, listed two keys to a page so a day that spans pages is read whole.
import type { TestBucket } from '../src/test-pool.js';
import type { TelemetryStore } from './erase-batches.js';

export const telemetryOf = (bucket: TestBucket, hooks: { beforeRemove?: () => void; beforeWrite?: () => void } = {}): TelemetryStore => ({
  list: async (prefix) => {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      keys.push(...page.objects.map((object) => object.key));
      if (page.truncated !== true) return keys;
      cursor = page.cursor;
    }
  },
  read: async (key) => (await bucket.get(key))?.text() ?? null,
  write: async (key, text) => {
    hooks.beforeWrite?.();
    await bucket.put(key, text);
  },
  remove: async (key) => {
    hooks.beforeRemove?.();
    await bucket.delete([key]);
  },
});
