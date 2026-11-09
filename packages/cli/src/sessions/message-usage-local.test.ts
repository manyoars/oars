// The per-message token counts and plan percent stay in the local observation log: nothing in the pool batch or its cell increments carries them.
import { describe, expect, it } from 'vitest';
import { incrementsOf } from './cell-increments.js';
import { canonicalBytes } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import type { MessageUsage } from './schema.js';

// Values no bucket edge, floor, or other field of the fixture can produce, so a hit in the wire bytes can only be these fields.
const MESSAGES: MessageUsage[] = [
  { id: 'msg_leak_probe', calls: ['toolu_leak_probe'], input: 7771234, cacheWrite: 7772345, cacheRead: 7773456, output: 7774567, thinking: 7775678, plan: { primary: { usedPercent: 61.37, windowMinutes: 301 }, secondary: { usedPercent: 83.91, windowMinutes: 10081 } } },
];
const framed = frame({ shell: 'bash' });

const batchOf = (messageUsage: MessageUsage[] | undefined) => {
  const from = store({
    sessions: [session('s1', { frame: framed, ...(messageUsage === undefined ? {} : { messageUsage }) })],
    prompts: [prompt('s1', 0, { frame: framed })],
    tools: [tool('s1', 0, 'Bash', { toolUseId: 'toolu_leak_probe', steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [], pulls: [] } })] })],
  });
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

describe('token usage stays local', () => {
  it('leaves the pool batch byte-for-byte what it is without the fields, and holds none of their values or names', () => {
    const withFields = batchOf(MESSAGES);
    const without = batchOf(undefined);
    expect(canonicalBytes(withFields)).toBe(canonicalBytes(without));
    const bytes = canonicalBytes(withFields);
    for (const probe of ['7771234', '7772345', '7773456', '7774567', '7775678', '61.37', '83.91', 'msg_leak_probe', 'toolu_leak_probe', 'messageUsage', 'usedPercent', 'windowMinutes']) {
      expect(bytes, probe).not.toContain(probe);
    }
  });

  it('leaves the cell increments, the deposit a batch becomes, the same', () => {
    expect(JSON.stringify(incrementsOf(batchOf(MESSAGES)))).toBe(JSON.stringify(incrementsOf(batchOf(undefined))));
  });
});
