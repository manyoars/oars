// The deposit wire's forward-compatibility contract under the Workers runtime (conclusion section 17, rules 1 to 4 and 7): the versions a batch carries are stored with it, a field this server does not know lands in the
// extensions bag and changes nothing that is served, a value it does not know is read as `other`, and a batch with every optional field absent is served from what remains.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { poolOf } from '../../cli/src/sessions/cells.js';
import { deriveCost } from '../../cli/src/sessions/read-cost.js';
import { FIELD_LIST_VERSION, OPTIONAL, skeletonOf, SKELETON_FORMAT, verifyBundle } from '../../cli/src/sessions/pool-wire.js';
import { VOCAB_VERSION } from '../../cli/src/sessions/public-vocabulary.js';
import { startPool, type Answer, type TestPool } from './test-pool.js';

const TOKEN = 'a-contract-token';
const ID = '0123456789abcdef';
const framed = frame({ shell: 'bash' });
let pool: TestPool;

/** A batch as plain JSON: a client's own newer or sparser form is this with something added or taken away. */
interface Wire {
  [key: string]: unknown;
}
const isWire = (value: unknown): value is Wire => typeof value === 'object' && value !== null;

const baseline = (id = ID): Wire => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['-f'] } });
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  const copy: unknown = JSON.parse(JSON.stringify(built));
  if (!isWire(copy)) throw new Error('a batch is an object');
  return copy;
};

const holder = (value: unknown, ...path: (string | number)[]): Wire => {
  const found = path.reduce<unknown>((held, key) => (isWire(held) ? held[String(key)] : undefined), value);
  if (!isWire(found)) throw new Error(`no object at ${path.join('.')}`);
  return found;
};
/** A batch with one top-level field left off, as an older client would send it. */
const without = (name: string): Wire => {
  const sent = baseline();
  Reflect.deleteProperty(sent, name);
  return sent;
};

const post = (body: Wire): Promise<Answer> => pool.post('/v1/deposits', JSON.stringify(body), TOKEN);

/** The accounts that, beside `acct-1`, reach the floor of five: each deposits the baseline batch under an id of its own. */
const PEERS = 4;
const seedPeers = async (): Promise<void> => {
  const db = await pool.db();
  for (let peer = 1; peer <= PEERS; peer += 1) {
    const account = `acct-peer-${String(peer)}`;
    const token = `${TOKEN}-peer-${String(peer)}`;
    await db.prepare("INSERT INTO accounts (id, covenant, access) VALUES (?, ?, 'standing')").bind(account, 'v1').run();
    await db.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind(createHash('sha256').update(token).digest('hex'), account, Date.now() + 600_000).run();
    expect((await pool.post('/v1/deposits', JSON.stringify(baseline(`00000000000000a${String(peer)}`)), token)).status).toBe(201);
  }
};

interface Row {
  skeleton: string;
  format: number;
  vocab_version: string;
  fields_version: number;
  extensions: string;
  other_values: number;
}

const isRow = (value: object): value is Row => 'skeleton' in value && 'extensions' in value && 'format' in value && 'vocab_version' in value && 'fields_version' in value && 'other_values' in value;

const rowOf = async (): Promise<Row> => {
  const row = await (await pool.db()).prepare('SELECT skeleton, format, vocab_version, fields_version, extensions, other_values FROM deposits WHERE account = ? AND id = ?').bind('acct-1', ID).first();
  if (row === undefined || row === null || !isRow(row)) throw new Error('no deposit row');
  return row;
};

/** Everything a bundle is derived from: the cells, the motifs, and the strata. */
const servedPlane = async (): Promise<unknown[]> => {
  const db = await pool.db();
  const tables = ['cells ORDER BY key', 'motifs ORDER BY motif_id', 'strata ORDER BY key'];
  return Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
};

/** The bundle a fetch is served, body and ETag: what a deposit may not change by carrying a field the server does not know. */
const bundleOf = async (): Promise<{ status: number; json: unknown; etag: string | null }> => {
  const served = await pool.raw(`/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, TOKEN);
  return { status: served.status, json: served.json, etag: served.headers.get('etag') };
};

/** How many cells a signed bundle serves: its payload is the bundle as JSON text. */
const servedCells = (json: unknown): number => {
  const payload = isWire(json) ? json.payload : undefined;
  const bundle: unknown = typeof payload === 'string' ? JSON.parse(payload) : undefined;
  const cells = isWire(bundle) ? bundle.cells : undefined;
  return Array.isArray(cells) ? cells.length : 0;
};

beforeAll(async () => {
  pool = await startPool();
  const db = await pool.db();
  await db.prepare("INSERT INTO accounts (id, covenant, access) VALUES ('acct-1', 'v1', 'standing')").run();
  await db.prepare("INSERT INTO tokens (hash, account, expires_at) VALUES (?, 'acct-1', ?)").bind(createHash('sha256').update(TOKEN).digest('hex'), Date.now() + 600_000).run();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

describe('the versions a deposit carries', () => {
  it('are stored with the batch', async () => {
    expect(await post(baseline())).toEqual({ status: 201, json: { ok: true, id: ID } });
    expect(await rowOf()).toMatchObject({ format: SKELETON_FORMAT, vocab_version: VOCAB_VERSION, fields_version: FIELD_LIST_VERSION, extensions: '[]', other_values: 0 });
  });

  it('refuse format 2 by name, the way format 1 is refused, and a batch with no versions', async () => {
    for (const format of [1, 2]) expect(await post({ ...baseline(), format })).toMatchObject({ status: 422, json: { error: 'closed_vocabulary', field: 'format' } });
    expect(await post(without('vocabVersion'))).toMatchObject({ status: 422, json: { field: 'vocabVersion' } });
    expect(await post(without('fieldsVersion'))).toMatchObject({ status: 422, json: { field: 'fieldsVersion' } });
  });

  it('store the versions a newer client names, so an older server reads a newer client', async () => {
    expect((await post({ ...baseline(), fieldsVersion: FIELD_LIST_VERSION + 3, vocabVersion: '99' })).status).toBe(201);
    expect(await rowOf()).toMatchObject({ format: SKELETON_FORMAT, vocab_version: '99', fields_version: FIELD_LIST_VERSION + 3 });
  });

  it('keep the names of a format 5 call in the stored skeleton, and still accept a format 4 batch, in which names and namesDropped are fields format 4 does not define', async () => {
    const names = [{ kind: 'dir', name: 'billing' }, { kind: 'file', name: 'plan.md' }];
    const named = baseline();
    Object.assign(holder(named, 'transcripts', 0, 'tools', 0), { names, namesDropped: 1 });
    expect((await post(named)).status).toBe(201);
    const stored = await rowOf();
    expect(JSON.parse(stored.skeleton)).toMatchObject({ transcripts: [{ tools: [{ names, namesDropped: 1 }] }] });
    expect(stored).toMatchObject({ format: 5, extensions: '[]', other_values: 0 });

    const older = { ...baseline(), format: 4 };
    expect((await post(older)).status).toBe(201);
    expect(await rowOf()).toMatchObject({ format: 4, extensions: '[]', other_values: 0 });
    Object.assign(holder(older, 'transcripts', 0, 'tools', 0), { names, namesDropped: 1 });
    expect((await post(older)).status).toBe(201);
    const bagged = await rowOf();
    expect(JSON.parse(bagged.extensions)).toEqual([{ at: 'transcripts[0].tools[0].names', kind: 'field', value: names }, { at: 'transcripts[0].tools[0].namesDropped', kind: 'field', value: 1 }]);
    expect(bagged.skeleton).not.toContain('billing');
  });
});

describe('a field this server does not know', () => {
  const LEVELS: { level: string; at: string; path: (string | number)[] }[] = [
    { level: 'batch', at: 'futureBatchField', path: [] },
    { level: 'transcript', at: 'transcripts[0].futureTranscriptField', path: ['transcripts', 0] },
    { level: 'frame', at: 'transcripts[0].frame.futureFrameField', path: ['transcripts', 0, 'frame'] },
    { level: 'step', at: 'transcripts[0].tools[0].steps[0].futureStepField', path: ['transcripts', 0, 'tools', 0, 'steps', 0] },
  ];

  it('answers 201 at every level, lands in the bag, and leaves every cell, motif, stratum, and the stored skeleton as the same batch without it', async () => {
    expect((await post(baseline())).status).toBe(201);
    // Five accounts, so that a cell clears the floor and the comparison below is over served rows, not an empty bundle.
    await seedPeers();
    const before = { plane: await servedPlane(), row: await rowOf(), bundle: await bundleOf() };
    expect(before.bundle).toMatchObject({ status: 200 });
    expect(servedCells(before.bundle.json)).toBeGreaterThan(0);
    expect(before.bundle.etag).not.toBeNull();
    expect(before.row.extensions).toBe('[]');
    const generation = await (await pool.db()).prepare('SELECT generation FROM pool_generation').first('generation');

    const extended = baseline();
    for (const { path, at } of LEVELS) holder(extended, ...path)[at.split('.').at(-1) ?? ''] = { nested: [1, 2, 3], note: `kept at ${at}` };
    expect((await post(extended)).status).toBe(201);

    const after = { plane: await servedPlane(), row: await rowOf(), bundle: await bundleOf() };
    expect(after.plane).toEqual(before.plane);
    // What a client is served: the bundle's body and its ETag are the same.
    expect(after.bundle).toEqual(before.bundle);
    expect(after.row.skeleton).toBe(before.row.skeleton);
    expect(await (await pool.db()).prepare('SELECT generation FROM pool_generation').first('generation')).toBe(generation);
    const stored: unknown = JSON.parse(after.row.extensions);
    if (!Array.isArray(stored)) throw new Error('the bag is a list');
    const bag = stored.filter(isWire);
    expect(bag.map(({ at }) => at).sort()).toEqual(LEVELS.map(({ at }) => at).sort());
    expect(bag.every(({ kind }) => kind === 'field')).toBe(true);
    expect(bag).toHaveLength(LEVELS.length);
    // The stored skeleton is the parsed one: nothing of the bag is in it.
    expect(after.row.skeleton).not.toContain('kept at');
  });

  it('is refused when it breaks a shape rule: a name that is no field name, a value too large for the request, and a body that is not JSON', async () => {
    expect(await post({ ...baseline(), 'a field with spaces': 1 })).toMatchObject({ status: 422, json: { field: 'a field with spaces' } });
    // Over the limit of one unknown field, whatever the deposit's own cap is.
    expect(await post({ ...baseline(), padding: 'x'.repeat(9 * 1024) })).toMatchObject({ status: 422, json: { field: 'padding', message: 'padding: too large' } });
    expect((await post({ ...baseline(), padding: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect((await pool.post('/v1/deposits', 'not json', TOKEN)).status).toBe(400);
  });
});

describe('a value this server does not know', () => {
  it('is read as other and counted, stored as other, and kept as sent in the bag', async () => {
    const sent = baseline();
    holder(sent, 'transcripts', 0, 'frame').model = 'a model from the future';
    holder(sent, 'transcripts', 0, 'prompts', 0).cls = 'a-class-from-the-future';
    expect((await post(sent)).status).toBe(201);
    const row = await rowOf();
    expect(row.other_values).toBe(2);
    expect(row.skeleton).not.toContain('from-the-future');
    expect(JSON.parse(row.extensions)).toEqual([
      { at: 'transcripts[0].frame.model', kind: 'value', value: 'a model from the future' },
      { at: 'transcripts[0].prompts[0].cls', kind: 'value', value: 'a-class-from-the-future' },
    ]);
    expect(JSON.parse(row.skeleton)).toMatchObject({ transcripts: [{ frame: { model: 'other' }, prompts: [{ cls: 'other' }] }] });
  });

  it('keeps the literal a client sends beside other, and only that', async () => {
    const sent = baseline();
    holder(sent, 'transcripts', 0, 'tools', 0).status = 'other';
    holder(sent, 'transcripts', 0, 'tools', 0).statusLiteral = 'paused';
    expect((await post(sent)).status).toBe(201);
    expect(JSON.parse((await rowOf()).extensions)).toEqual([{ at: 'transcripts[0].tools[0].statusLiteral', kind: 'literal', value: 'paused' }]);
  });
});

describe('a format 5 batch with every optional field absent', () => {
  /** What an absent optional field reads as, which is what a sent null is. */
  const EMPTY: { [name: string]: unknown } = { deltas: [], timingPrint: null, languageShares: [] };
  const ABSENT_ONLY: ReadonlySet<string> = new Set(['claimed', 'reach', 'skill', 'edges', 'recoveryCalls', 'usageResponses', 'allocated', 'repoKey', 'orgSize', 'team', 'repoVisibility', 'hour', 'keys', 'keysDropped', 'targetClass', 'argClass', 'argFeatures', 'argValues', 'changeKind', 'names', 'namesDropped']);

  // Each level of the wire with its optional names and where it sits; a level added to OPTIONAL fails the length check below until it is listed here.
  const LEVELS_OPTIONAL: readonly (readonly [readonly string[], (string | number)[]])[] = [
    [OPTIONAL.batch, []],
    [OPTIONAL.frame, ['transcripts', 0, 'frame']],
    [OPTIONAL.stack, ['transcripts', 0, 'frame', 'stack']],
    [OPTIONAL.prompt, ['transcripts', 0, 'prompts', 0]],
    [OPTIONAL.tool, ['transcripts', 0, 'tools', 0]],
    [OPTIONAL.step, ['transcripts', 0, 'tools', 0, 'steps', 0]],
    [OPTIONAL.transcript, ['transcripts', 0]],
  ];

  it('is served from what remains, as the same batch with each of them sent as null', async () => {
    const nulled = baseline();
    const sparse = baseline();
    expect(LEVELS_OPTIONAL).toHaveLength(Object.keys(OPTIONAL).length);
    for (const [names, path] of LEVELS_OPTIONAL) {
      for (const name of names) {
        // A reach, a skill, an edge list, a recoveryCalls, an allocated, a usageResponses, a repoKey, a coverage band, or an hour has no null form: it is an object, a list member, a list left out when empty, a true-only flag, a count left out on a record that predates the coverage, or a value the parser refuses as null, so sending nothing is the one way to leave it out.
        if (ABSENT_ONLY.has(name)) Reflect.deleteProperty(holder(nulled, ...path), name);
        else holder(nulled, ...path)[name] = name in EMPTY ? EMPTY[name] : null;
        Reflect.deleteProperty(holder(sparse, ...path), name);
      }
    }
    expect((await post(nulled)).status).toBe(201);
    const withNulls = { plane: await servedPlane(), row: await rowOf() };
    expect((await post(sparse)).status).toBe(201);
    const withNone = { plane: await servedPlane(), row: await rowOf() };
    expect(withNone.row.skeleton).toBe(withNulls.row.skeleton);
    expect(withNone.plane).toEqual(withNulls.plane);
    expect(withNone.row.extensions).toBe('[]');
  });

  it('is refused for a field the cells need to be sound: a harness, a status, a bucket of tokens', async () => {
    for (const [path, name] of [
      [['transcripts', 0], 'harness'],
      [['transcripts', 0, 'tools', 0], 'status'],
      [['transcripts', 0, 'prompts', 0, 'usage'], 'input'],
    ] as const) {
      const sent = baseline();
      Reflect.deleteProperty(holder(sent, ...path), name);
      expect(await post(sent)).toMatchObject({ status: 422, json: { error: 'closed_vocabulary' } });
    }
  });
});

describe('the bag', () => {
  it('is read by nothing that serves a read: no source file outside the deposit route and the account\'s own export (Article 15 copy) names the column', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const readers = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => /\bextensions\b|\bother_values\b/.test(readFileSync(`${dir}${file}`, 'utf8')));
    expect(readers).toEqual(['export.ts', 'worker.ts']);
  });

  it('is left out of a bundle: a stored bag changes no cell a bundle is derived from', async () => {
    const sent = baseline();
    holder(sent, 'transcripts', 0).secretLookingField = 'a-string-no-bundle-may-carry';
    expect((await post(sent)).status).toBe(201);
    const plane = JSON.stringify(await servedPlane());
    expect(plane).not.toContain('a-string-no-bundle-may-carry');
  });
});

describe('a bundle from a pool older than the coverage fields (t921)', () => {
  it('verifies, and its cost read says coverage is unknown instead of guessing every prompt recorded input', async () => {
    // An earlier test in this file may have seeded the peers already; the pool is shared.
    if (servedCells((await bundleOf()).json) === 0) {
      await seedPeers();
      await post(baseline());
    }
    const served = await bundleOf();
    const payload = isWire(served.json) ? served.json.payload : undefined;
    const bundle: unknown = typeof payload === 'string' ? JSON.parse(payload) : undefined;
    if (!isWire(bundle) || !Array.isArray(bundle.cells)) throw new Error('a served bundle has cells');
    // An old pool's cells: the same rows with neither coverage field.
    const cells = bundle.cells.filter(isWire).map((cell) => {
      const old = { ...cell };
      Reflect.deleteProperty(old, 'tokenSessions');
      Reflect.deleteProperty(old, 'tokenPrompts');
      return old;
    });
    expect(cells.length).toBeGreaterThan(0);
    const old = JSON.stringify({ ...bundle, cells, reads: [] });
    // The test signs with a key of its own: the pool's private key never leaves the Worker.
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('an Ed25519 key pair');
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(old))).toString('base64');
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const verified = await verifyBundle({ payload: old, signature }, { k1: { kty: exported.kty ?? '', crv: exported.crv ?? '', x: exported.x ?? '' } }, 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.bundle.cells.every((cell) => cell.tokenSessions === undefined && cell.tokenPrompts === undefined)).toBe(true);
    const reads = deriveCost({ pool: poolOf({ cells: verified.bundle.cells, motifs: verified.bundle.motifs }, []), store: store({}) });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => isWire(read.value) && read.value.tokenCoverage === 'unknown')).toBe(true);
  }, 60_000);
});
