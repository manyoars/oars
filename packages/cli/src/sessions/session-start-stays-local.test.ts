// The start-of-session snapshot and the loaded set it is joined with stay on this machine: neither reaches the pool wire or a batch a deposit queues. The check is two-sided: the keys the
// snapshot owns never appear in the payload, and the payload is byte-identical to the one built from the same session with no snapshot and no loaded set.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANDIDATES_FILE, type CandidateSnapshot } from './candidates.js';
import { LOAD_STATUS_FILE } from './load-status.js';
import { canonicalBytes, outboxFolder, writeBatch } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, storedNames, store } from './pool-fixture.js';
import { poolFiles, refreshPool } from './pool.js';
import { skeletonOf, type SessionSkeleton } from './pool-wire.js';
import type { SessionObservation } from './schema.js';

/** Every key the snapshot, the loaded set, or a status row owns. A name the wire already uses for something else (`skills`) is covered by the byte comparison instead. */
const OWNED_KEYS = ['loadedInstructions', 'repoLevels', 'mainLevels', 'mainCheckout', 'instructions', 'hooks', 'levels', 'candidates', 'loadStatus'];

const SNAPSHOT: CandidateSnapshot = {
  v: 1,
  session: 's1',
  at: '2026-11-09T07:00:00.000Z',
  harness: 'claude-code',
  instructions: { working: 3, parent: 2, above: 1, mainCheckout: 5, user: 1 },
  skills: { project: 4, user: 7 },
  hooks: { SessionStart: 1, PreToolUse: 2 },
  repoLevels: 2,
  mainLevels: 3,
};

const framed = frame({ shell: 'bash' });
const withLoaded = (): SessionObservation => session('s1', { frame: framed, loadedInstructions: { user: 1, levels: [0] } });
const bare = (): SessionObservation => session('s1', { frame: framed });
const fromSession = (one: SessionObservation): ReturnType<typeof store> => store({ sessions: [one], prompts: [prompt('s1', 0, { frame: framed })] });

const skeletonOfStore = (from: ReturnType<typeof store>): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, held]) => [key, ...keysOf(held)]) : [];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-stays-local-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the session-start snapshot stays local', () => {
  it('leaves the pool wire payload of a session with a snapshot byte-identical to one without', () => {
    writeFileSync(join(dir, CANDIDATES_FILE), `${JSON.stringify(SNAPSHOT)}\n`);
    const sent = skeletonOfStore(fromSession(withLoaded()));
    expect(canonicalBytes(sent)).toBe(canonicalBytes(skeletonOfStore(fromSession(bare()))));
    const keys = new Set(keysOf(JSON.parse(JSON.stringify(sent))));
    for (const owned of OWNED_KEYS) expect(keys.has(owned), owned).toBe(false);
  });

  it('leaves the batch a deposit queues byte-identical, with the snapshot and the status rows beside it in the store', async () => {
    writeFileSync(join(dir, CANDIDATES_FILE), `${JSON.stringify(SNAPSHOT)}\n`);
    await refreshPool(dir, fromSession(withLoaded()));
    const outbox = outboxFolder(dir, 'https://pool.example');
    const queued = await writeBatch(outbox, '0123456789abcdef', skeletonOfStore(fromSession(withLoaded())));
    const control = await writeBatch(join(dir, 'control'), '0123456789abcdef', skeletonOfStore(fromSession(bare())));
    const [file] = readdirSync(queued.folder);
    const [controlFile] = readdirSync(control.folder);
    const bytes = readFileSync(join(queued.folder, file ?? ''), 'utf8');
    expect(bytes).toBe(readFileSync(join(control.folder, controlFile ?? ''), 'utf8'));
    expect(file).toBe(controlFile);
    for (const owned of OWNED_KEYS) expect(bytes, owned).not.toContain(`"${owned}"`);
  });

  it('keeps the snapshot values and the labels out of the pool cells and motifs', async () => {
    writeFileSync(join(dir, CANDIDATES_FILE), `${JSON.stringify(SNAPSHOT)}\n`);
    await refreshPool(dir, fromSession(withLoaded()));
    const files = poolFiles(dir);
    const control = mkdtempSync(join(tmpdir(), 'oars-stays-local-control-'));
    try {
      await refreshPool(control, fromSession(bare()));
      const controlFiles = poolFiles(control);
      expect(readFileSync(files.cells, 'utf8')).toBe(readFileSync(controlFiles.cells, 'utf8'));
      expect(readFileSync(files.motifs, 'utf8')).toBe(readFileSync(controlFiles.motifs, 'utf8'));
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  it('writes the status rows to the store beside the log, where nothing reads them for a payload', async () => {
    writeFileSync(join(dir, CANDIDATES_FILE), `${JSON.stringify(SNAPSHOT)}\n`);
    await refreshPool(dir, fromSession(withLoaded()));
    const [row] = readFileSync(join(dir, LOAD_STATUS_FILE), 'utf8').trim().split('\n');
    expect(JSON.parse(row ?? '')).toMatchObject({ session: 's1', harness: 'claude-code', instructions: { working: 'loaded', parent: 'miss', user: 'loaded' } });
  });
});
