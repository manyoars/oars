import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { heldRaw, rawHash, rawStamp, writeRaw } from './pool-raw.js';

// t1559: the email rule changed, so a raw copy queued under redaction 5 and capture 35 must not be sent; it is built again under the new stamp.
describe('the raw copy stamp', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('names redaction 6 and capture 36', () => {
    expect(rawStamp()).toBe('raw-r6-c36');
  });

  it('holds a copy under the old raw-r5-c35 folder out of the current copies', async () => {
    const outbox = mkdtempSync(join(tmpdir(), 'oars-raw-stamp-'));
    folders.push(outbox);
    const body = 'mail <email> now\n';
    const old = join(outbox, 'raw-r5-c35');
    mkdirSync(old);
    writeFileSync(join(old, `0123456789abcdef.0.${rawHash(body)}.redacted`), body);
    expect((await heldRaw(outbox)).copies).toEqual([]);
    await writeRaw(outbox, '0123456789abcdef', 0, body);
    expect((await heldRaw(outbox)).copies.map((copy) => copy.key)).toEqual(['0123456789abcdef']);
  });
});
