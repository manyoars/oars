// A transcript the harness no longer has is captured again from raw/ when the redaction domains change, so a domain the operator adds later
// is masked in what was captured before it was named (t884 Item 6, finding 17 of the t887 review).
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deposit, readState } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

describe('a raw-only transcript and the redaction domains', () => {
  it('is captured again when a redaction domain is added after it was captured', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    const again = await deposit(staged.runtime, { allow: ['proj'], redactDomains: ['acme.example'], now: () => NOW });
    expect(again.sessions).toBe(4);
    const kept = Object.values((await readState(staged.storeDir)).files);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((entry) => entry.d.join(',') === 'acme.example')).toBe(true);
    expect((await deposit(staged.runtime, { allow: ['proj'], redactDomains: ['acme.example'], now: () => NOW })).sessions).toBe(0);
  });
});
