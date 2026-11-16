import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeFake } from './fake-harness.js';
import type { RunRequest } from './harness.js';
import { parseOrder } from './order.js';
import { FLEET, retestText } from './test-fixtures.js';

const request = (runId: string): RunRequest => ({
  runId,
  sequence: 1,
  attempt: 1,
  order: parseOrder(retestText(), FLEET),
  taskId: 't1',
  category: 'browser',
  arm: 'playwright',
  side: 'before',
  repeat: 1,
  expected: { taskSetVersion: 'v1', fixtureTag: 'taskset-v1', manifestVersion: 'fleet-1', harnessVersion: '2.1.30', modelId: 'sonnet-pinned-1', toolPins: [{ name: 'playwright', pin: 'npm:1.0.0' }] },
});

describe('the fake harness', () => {
  it('runs clean by default: a transcript in a temp folder that dispose removes', async () => {
    const fake = makeFake();
    const prepared = await fake.prepare(request('r1'));
    expect(prepared.installedPins).toEqual([{ name: 'playwright', pin: 'npm:1.0.0' }]);
    const result = await fake.run(prepared, request('r1'));
    expect(result.exit).toEqual({ kind: 'ok', code: 0 });
    expect(await readFile(result.transcriptPath ?? '', 'utf8')).toContain('r1');
    expect(await fake.check(prepared, request('r1'))).toBe('pass');
    expect(fake.open.size).toBe(1);
    await prepared.dispose();
    expect(fake.open.size).toBe(0);
    await expect(stat(prepared.dir)).rejects.toThrow();
    expect(fake.prepared).toEqual(['r1']);
  });

  it('injects each fault the test scripts', async () => {
    const fake = makeFake(() => ({
      exit: 'rate-limit',
      installedPins: [],
      taskSetVersion: 'v9',
      fixtureTag: 'other',
      manifestVersion: 'fleet-9',
      harnessVersion: '9.9',
      modelId: 'other-model',
      check: 'fail',
      tokens: { input: 1, cache: 2, output: 3 },
      noTranscript: true,
    }));
    const prepared = await fake.prepare(request('r2'));
    const result = await fake.run(prepared, request('r2'));
    expect(result).toMatchObject({ exit: { kind: 'rate-limit', code: 1 }, transcriptPath: null, harnessVersion: '9.9', modelId: 'other-model', tokens: { input: 1, cache: 2, output: 3 } });
    expect(prepared).toMatchObject({ installedPins: [], taskSetVersion: 'v9', fixtureTag: 'other', manifestVersion: 'fleet-9' });
    expect(await fake.check(prepared, request('r2'))).toBe('fail');
    await prepared.dispose();
  });
});
