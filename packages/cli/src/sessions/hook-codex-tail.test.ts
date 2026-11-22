// t1558 Item 5: PostToolUse fires on every call, so the failure read must touch only the rollout's tail. The proof is bytes read, not wall time: a 50 MB rollout is read through a handle that
// counts what `read` returned, and the count stays within the tail window.
import { appendFileSync, ftruncateSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Fsp from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const counted = vi.hoisted(() => ({ bytes: 0, reads: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual: typeof Fsp = await importOriginal();
  return {
    ...actual,
    // The three calls the tail read makes, counted: what `read` returned is what the process pulled off the disk.
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await handle.read(buffer, offset, length, position);
          counted.bytes += result.bytesRead;
          counted.reads += 1;
          return result;
        },
      };
    },
  };
});

const { callFailureOf } = await import('./codex-rollout.js');
const { TAIL_BYTES } = await import('./transcript-tail.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  counted.bytes = 0;
  counted.reads = 0;
});

const BIG = 50 * 1024 * 1024;

/** A rollout of at least 50 MB whose bulk is a hole (never written, never read), with the call's output line at its end. */
const bigRollout = (callId: string, body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-rollout-'));
  dirs.push(dir);
  const file = join(dir, 'rollout.jsonl');
  const fd = openSync(file, 'w');
  ftruncateSync(fd, BIG);
  closeSync(fd);
  appendFileSync(file, `\n${JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: body } })}\n`);
  return file;
};

describe('the rollout read of a failed call', () => {
  it('finds the failure in a 50 MB rollout by reading only its tail', async () => {
    const file = bigRollout('call_7', 'Process exited with code 3\nOutput:\nboom');
    expect(await callFailureOf(file, 'call_7')).toBe('Exit code 3\nboom');
    expect(counted.bytes).toBeGreaterThan(0);
    expect(counted.bytes).toBeLessThanOrEqual(TAIL_BYTES);
    expect(counted.bytes).toBeLessThan(BIG / 100);
  });

  it('reads the same bounded tail when the call is not there', async () => {
    const file = bigRollout('call_7', 'Process exited with code 3\nOutput:\nboom');
    expect(await callFailureOf(file, 'call_8')).toBeUndefined();
    expect(counted.bytes).toBeLessThanOrEqual(TAIL_BYTES);
  });
});
