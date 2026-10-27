import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createFakeBilling, createFakeRecovery } from '../../src/fake-billing.js';

const read = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const flat = (name: string): string => read(name).replace(/\s+/g, ' ');

describe('the charging sentence', () => {
  it('reads the same in README.md and in the GET / body', async () => {
    const billing = createFakeBilling({ now: Date.now });
    const app = createApp({
      billing,
      recovery: createFakeRecovery({ billing, now: Date.now }),
      priceRefs: ['task-1'],
      checkoutUrls: { successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' },
      fetchPage: () => Promise.reject(new Error('GET / fetches nothing')),
    });

    const body: unknown = await (await app.request('/')).json();

    const charging = typeof body === 'object' && body !== null && 'charging' in body ? body.charging : undefined;
    expect(typeof charging).toBe('string');
    expect(flat('README.md')).toContain(String(charging));
  });

  it('is followed in the README by the replay rules, including that a failed replay does not refund', () => {
    expect(flat('README.md')).toContain('a replay re-runs the call free; a failed replay does not refund the original charge');
  });
});

describe('README.md', () => {
  it('says where the 45-second budget comes from, so a developer can find the reasoning', () => {
    const readme = flat('README.md');

    expect(readme).toContain('45-second');
    expect(readme).toContain('60-second hold');
    expect(readme).toContain('1T minimum design, section 2.3');
  });

  it('says a failed page, a non-HTML page and a failed summary cost the buyer nothing', () => {
    const readme = flat('README.md');

    expect(readme).toContain('ANTHROPIC_API_KEY');
    expect(readme).toMatch(/non-HTML page.*(no charge|pays nothing|costs? nothing)/i);
    expect(readme).toMatch(/summary.*(no charge|pays nothing|costs? nothing|not charged)/i);
  });
});

describe('AGENTS.md and CLAUDE.md', () => {
  it('CLAUDE.md is the one line that imports AGENTS.md', () => {
    expect(read('CLAUDE.md').trim()).toBe('@AGENTS.md');
  });

  it('AGENTS.md names the work to replace and the line that charges, and both exist', () => {
    const agents = read('AGENTS.md');

    expect(agents).toContain('`src/audit.ts`');
    expect(agents).toContain('`withCredits(...)` call in the `/v1/tasks` route of `src/app.ts`');
    for (const file of ['src/audit.ts', 'src/app.ts', 'src/billing.ts']) expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
    expect(read('src/app.ts')).toContain("app.post('/v1/tasks'");
  });

  it('AGENTS.md keeps the rules that stop an agent from rewiring billing or the SSRF guard', () => {
    const agents = read('AGENTS.md');

    expect(agents).toMatch(/never add Stripe/i);
    expect(agents).toContain('GET /healthz');
    expect(agents).toContain('src/fetch-page.ts');
  });
});
