import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchHash, BATCH_FIELDS, canonicalBytes, currentStamp, FIELD_ROWS, fieldsOf, writeBatch } from './pool-outbox.js';
import { parseSkeleton, SKELETON_FORMAT } from './pool-wire.js';

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

// A batch the vocabulary accepts, holding every field the format has: each identity form, a pull, an edge, and a nested stack.
const FRAME = { harness: 'claude-code', harnessVersion: '2.1.314', model: 'claude-opus-5-5', effort: 'high', day: '2026-11-01', platform: 'linux', shell: 'bash', stack: { languages: [], frameworks: [], size: null } };
const STEP = { seg: 0, status: 'ok', cost: { tokens: 3, durationMs: 4 }, parent: null, edges: [{ kind: 'next', n: 1, seg: 0 }] };
const REAL = {
  format: SKELETON_FORMAT,
  id: '0123456789abcdef',
  transcripts: [
    {
      spawnedIn: null,
      harness: 'claude-code',
      frame: FRAME,
      prompts: [{ index: 0, cls: 'edit-verify', errors: 0, wallSec: 5, usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, thinking: 5 }, frame: FRAME }],
      tools: [
        {
          n: 0,
          side: false,
          prompt: 0,
          status: 'ok',
          durationMs: 7,
          steps: [
            { ...STEP, action: 'shell.exec', native: 'Bash', identity: { program: 'npm', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null }] } },
            { ...STEP, action: 'mcp.call', native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } },
            { ...STEP, action: 'skill.run', native: 'Skill', identity: { skill: 'commit' } },
            { ...STEP, action: 'web.fetch', native: 'WebFetch', identity: { host: 'github.com' } },
          ],
        },
      ],
    },
  ],
};

describe('the fields of a batch', () => {
  it('the sample is a batch the vocabulary accepts', () => {
    expect(parseSkeleton(JSON.parse(canonicalBytes(REAL)))).toMatchObject({ ok: true });
  });

  it('are the fields of a real batch at every depth, each once, and each has a row', () => {
    const fields = fieldsOf(canonicalBytes(REAL));
    expect(fields).toEqual([...BATCH_FIELDS]);
    expect(new Set(fields).size).toBe(fields.length);
    expect(Object.keys(FIELD_ROWS).sort()).toEqual(fields);
  });

  it('count a key of an array element and one only in a nested object', () => {
    expect(fieldsOf('{"a":[{"b":{"c":1}},{"b":2}],"d":[1,[{"e":null}]]}\n')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fieldsOf('7\n')).toEqual([]);
  });
});

describe('the stamp', () => {
  it('follows the skeleton format as well as the field list', () => {
    expect(currentStamp(BATCH_FIELDS, SKELETON_FORMAT + 1)).not.toBe(currentStamp());
    expect(currentStamp([...BATCH_FIELDS, 'extra'])).not.toBe(currentStamp());
    expect(currentStamp()).toBe(currentStamp(BATCH_FIELDS, SKELETON_FORMAT));
  });
});
