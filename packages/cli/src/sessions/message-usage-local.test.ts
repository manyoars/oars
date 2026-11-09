// The per-message token counts and plan percent stay in the local observation log: nothing in the pool batch or its cell increments carries them.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incrementsOf } from './cell-increments.js';
import { transcriptFilesOf } from './exclusion.js';
import { canonicalBytes } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
import { skeletonOf } from './pool-wire.js';
import { redactTranscript } from './redact.js';
import type { MessageUsage } from './schema.js';
import { deposit, loadStore } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

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

describe('token usage stays out of the raw copy', () => {
  let appData: string;
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'oars-message-usage-appdata-'));
    vi.stubEnv('APPDATA', appData);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(appData, { recursive: true, force: true });
    cleanup();
  });

  it('builds the raw copy from the transcript, so it holds none of the derived field names', async () => {
    const staged = stage('proj');
    expect(staged.storeDir.startsWith(staged.root)).toBe(true);
    expect(process.env.APPDATA).toBe(appData);
    expect(staged.storeDir.startsWith(appData)).toBe(false);
    const usage = { input_tokens: 7771234, output_tokens: 7774567, cache_read_input_tokens: 7773456, cache_creation_input_tokens: 7772345 };
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-06-01T00:00:00.000Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', requestId: 'req-1', timestamp: '2026-06-01T00:00:01.000Z', message: { id: 'msg_1', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }], usage } }),
    ];
    addProject(staged, 'proj', 'usage-raw', lines);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    // The derived field exists in the local log, so the assertions below test something that could have leaked.
    expect((await loadStore(staged.storeDir)).sessions.find((entry) => entry.session === 'usage-raw')?.messageUsage).toHaveLength(1);

    const files = await transcriptFilesOf(staged.runtime, 'proj', 'usage-raw');
    expect(files).toHaveLength(1);
    for (const file of files) {
      const { text } = redactTranscript(readFileSync(file.path, 'utf8'));
      // The transcript's own usage lines are not derived fields and stay as the transcript wrote them.
      expect(text).toContain('input_tokens');
      for (const name of ['messageUsage', 'rateLimits', 'usedPercent', 'windowMinutes']) expect(text, name).not.toContain(name);
    }
  });
});
