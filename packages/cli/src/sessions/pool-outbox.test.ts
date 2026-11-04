import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchHash, canonicalBytes, writeBatch } from './pool-outbox.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'oars-outbox-test-'));
  roots.push(root);
  return root;
};

// One batch, pinned as the exact bytes that would be sent: keys sorted at every depth, no optional whitespace, UTF-8, one line.
const BATCH = { z: 'é', id: 'abc', format: 1, transcripts: [{ prompts: [], harness: 'claude-code', frame: { model: 'm', day: '2026-11-01' } }] };
const BYTES = '{"format":1,"id":"abc","transcripts":[{"frame":{"day":"2026-11-01","model":"m"},"harness":"claude-code","prompts":[]}],"z":"é"}\n';
const HASH = 'c7109174d51a41fb71b6fac911bd097487bf9b51f4f9fd84869ed8d27dfe11b9';
const KEY = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';

describe('canonical bytes', () => {
  it('are one pinned byte string, whatever order the keys came in', () => {
    expect(canonicalBytes(BATCH)).toBe(BYTES);
    const reordered = { transcripts: [{ frame: { day: '2026-11-01', model: 'm' }, prompts: [], harness: 'claude-code' }], format: 1, z: 'é', id: 'abc' };
    expect(canonicalBytes(reordered)).toBe(BYTES);
    expect(Buffer.from(canonicalBytes(reordered)).equals(Buffer.from(BYTES, 'utf8'))).toBe(true);
  });

  it('hash to a pinned SHA-256, over the UTF-8 bytes', () => {
    expect(batchHash(BYTES)).toBe(HASH);
    expect(createHash('sha256').update(Buffer.from(BYTES, 'utf8')).digest('hex')).toBe(HASH);
  });
});

describe('the outbox', () => {
  it('holds each batch as the canonical line, named by the hash of its bytes', async () => {
    const dir = temp();
    const written = await writeBatch(dir, KEY, BATCH);
    expect(written.hash).toBe(HASH);
    const files = readdirSync(written.folder);
    expect(files).toEqual([`${KEY}.${HASH}.jsonl`]);
    expect(readFileSync(join(written.folder, files[0] ?? ''), 'utf8')).toBe(BYTES);
  });

  it('writes the same batch twice as one file, and a changed batch of one session replaces the old one', async () => {
    const dir = temp();
    await writeBatch(dir, KEY, BATCH);
    const again = await writeBatch(dir, KEY, { ...BATCH, z: 'e' });
    expect(readdirSync(again.folder)).toEqual([`${KEY}.${again.hash}.jsonl`]);
    await writeBatch(dir, KEY, { ...BATCH, z: 'e' });
    expect(readdirSync(again.folder)).toHaveLength(1);
    await writeBatch(dir, OTHER, BATCH);
    expect(readdirSync(again.folder)).toHaveLength(2);
  });

  it('keeps a file of another name where it finds one', async () => {
    const dir = temp();
    const first = await writeBatch(dir, KEY, BATCH);
    mkdirSync(join(first.folder, 'notes'));
    writeFileSync(join(first.folder, 'readme.txt'), 'x');
    await writeBatch(dir, KEY, { ...BATCH, z: 'e' });
    expect(readdirSync(first.folder)).toContain('readme.txt');
  });
});
