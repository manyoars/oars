// What a call touched, as the wire holds it (t870): key names from a pinned list, a target class, and argument classes. Every name and value here is invented.
import { describe, expect, it } from 'vitest';
import { storeOf } from './cell-increments.js';
import { captureSession } from './extract.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { bucketOf, parseSkeleton, skeletonOf, type SessionSkeleton, type WireGate } from './pool-wire.js';
import { makeRedactor } from './redact.js';

const framed = frame({ shell: 'bash', model: 'claude-opus-5-5' });
const clone = (skeleton: SessionSkeleton): SessionSkeleton => structuredClone(skeleton);

const skeletonOfStore = (from: ReturnType<typeof store>, gate?: WireGate): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], gate);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

/** One session with one call of the named tool and the given stored fields. */
const oneCall = (name: string, over: Partial<ReturnType<typeof tool>> = {}, gate?: WireGate): SessionSkeleton =>
  skeletonOfStore(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [tool('s1', 0, name, { steps: [step(0, 0, 'file.read', { native: name })], ...over })],
    }),
    gate,
  );
const first = (skeleton: SessionSkeleton) => {
  const only = skeleton.transcripts[0]?.tools[0];
  if (only === undefined) throw new Error('no call');
  return only;
};

describe('keys on the wire', () => {
  it('sends the key names of a public tool from its pinned list, sorted, and counts the rest', () => {
    const sent = first(oneCall('Read', { keys: ['limit', 'file_path', 'zzz_off_list', 'offset'] }));
    expect(sent.keys).toEqual(['file_path', 'limit', 'offset']);
    expect(sent.keysDropped).toBe(1);
  });

  it('sends no keysDropped when nothing was dropped, and no keys for a call with none', () => {
    expect(first(oneCall('Read', { keys: ['file_path'] }))).not.toHaveProperty('keysDropped');
    const none = first(oneCall('Read', { keys: [] }));
    expect(none).not.toHaveProperty('keys');
    expect(none).not.toHaveProperty('keysDropped');
  });

  it('sends the names of a tool off the pinned lists only when they pass the name gate', () => {
    const gate: WireGate = { redact: (text) => text, terms: ['acmecorp'] };
    const sent = first(oneCall('WorkspaceHelper', { keys: ['query', 'acmecorp_token', 'has space'] }, gate));
    expect(sent.keys).toEqual(['query']);
    expect(sent.keysDropped).toBe(bucketOf('count', 2));
  });

  it('sends no names for a tool that went as private', () => {
    const sent = first(oneCall('acmecorp_internal_deploy', { keys: ['query'] }, { redact: (text) => text, terms: ['acmecorp'] }));
    expect(sent).not.toHaveProperty('keys');
    expect(sent.keysDropped).toBe(1);
  });

  it('reads an off-list key as other, counted and held in the bag, and does not refuse the batch', () => {
    const wire = clone(oneCall('Read', { keys: ['file_path'] }));
    const only = first(wire);
    only.keys = ['file_path', 'planted_unlisted_key'];
    const parsed = parseSkeleton(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skeleton.transcripts[0]?.tools[0]?.keys).toEqual(['file_path', 'other']);
    expect(parsed.others).toBe(1);
    expect(parsed.extensions).toContainEqual({ at: 'transcripts[0].tools[0].keys[1]', kind: 'value', value: 'planted_unlisted_key' });
  });

  it('reads a key that is no name shape as other, and refuses a keys that is no list', () => {
    const wire = clone(oneCall('WorkspaceHelper', { keys: ['query'] }));
    first(wire).keys = ['a b'];
    expect(parseSkeleton(wire)).toMatchObject({ ok: true, others: 1 });
    Reflect.set(first(wire), 'keys', 'file_path');
    expect(parseSkeleton(wire)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].keys' });
  });

  it('refuses a keysDropped that is no bucket', () => {
    const wire = clone(oneCall('Read', { keys: ['file_path'] }));
    first(wire).keysDropped = 99;
    expect(parseSkeleton(wire)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].keysDropped' });
  });
});

describe('the target class and the argument classes on the wire', () => {
  it('send the stored classes', () => {
    const sent = first(oneCall('Read', { keys: ['file_path'], targetClass: 'test', argClass: ['path', 'number'] }));
    expect(sent.targetClass).toBe('test');
    expect(sent.argClass).toEqual(['number', 'path']);
  });

  it('send nothing for a call captured before them, and never a value off the closed list', () => {
    const old = first(oneCall('Read', { keys: ['file_path'] }));
    expect(old).not.toHaveProperty('targetClass');
    expect(old).not.toHaveProperty('argClass');
    const record = tool('s1', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read' })] });
    Reflect.set(record, 'targetClass', '/home/me/secret.ts');
    Reflect.set(record, 'argClass', ['path', 'secret-value']);
    const edited = first(skeletonOfStore(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [record] })));
    expect(edited).not.toHaveProperty('targetClass');
    expect(edited.argClass).toEqual(['path']);
  });

  it('read a class off the closed list as other', () => {
    const wire = clone(oneCall('Read', { targetClass: 'source', argClass: ['path'] }));
    Reflect.set(first(wire), 'targetClass', 'brand-new-class');
    Reflect.set(first(wire), 'argClass', ['path', 'brand-new-arg']);
    const parsed = parseSkeleton(wire);
    expect(parsed).toMatchObject({ ok: true, others: 2 });
    if (parsed.ok) expect(parsed.skeleton.transcripts[0]?.tools[0]).toMatchObject({ targetClass: 'other', argClass: ['path', 'other'] });
  });
});

describe('a planted value is on the wire nowhere', () => {
  const redact = makeRedactor();
  const line = (type: string, content: unknown): string =>
    JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type, model: 'claude-opus-5-5', content } });
  const call = (id: string, name: string, input: object): string => line('assistant', [{ type: 'tool_use', id, name, input }]);
  const PLANTED = ['quokka-ledger', 'marmalade-secret', 'octopus-pattern', 'walrus --flag', 'walrus-urlpath'];
  // A fetched URL's host is a long-tail name since CAPTURE 24 (t903): it crosses as `identity.host` and the pool hashes it on arrival. The URL's path and the prompt never do.
  const HOST = 'zephyr.example.org';

  it('keeps every planted path, URL path, pattern, command, and text out of a whole batch, and sends a URL host as a name', () => {
    const text = [
      line('user', 'go'),
      call('t1', 'Read', { file_path: 'src/quokka-ledger.ts', offset: 5 }),
      call('t2', 'Grep', { pattern: 'octopus-pattern', path: 'src', glob: '*.marmalade-secret' }),
      call('t3', 'WebFetch', { url: 'https://zephyr.example.org/walrus-urlpath', prompt: 'marmalade-secret' }),
      call('t4', 'Bash', { command: 'walrus --flag', description: 'quokka-ledger' }),
      call('t5', 'WorkspaceHelper', { quokka_key: 1, query: 'marmalade-secret' }),
    ].join('\n');
    const captured = captureSession({ text, session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact });
    const from = store({ sessions: [captured.session], prompts: [], tools: captured.tools });
    const skeleton = skeletonOfStore(from);
    const batch = JSON.stringify(skeleton);
    for (const value of PLANTED) expect(batch).not.toContain(value);
    expect(batch.split(HOST)).toHaveLength(2);
    // The key names and the classes did cross.
    const tools = skeleton.transcripts[0]?.tools ?? [];
    expect(tools[0]).toMatchObject({ keys: ['file_path', 'offset'], targetClass: 'source', argClass: ['number', 'path'] });
    expect(tools[1]).toMatchObject({ keys: ['glob', 'path', 'pattern'], targetClass: 'other', argClass: ['path', 'pattern'] });
    expect(tools[2]).toMatchObject({ keys: ['prompt', 'url'], argClass: ['text', 'url'] });
    expect(tools[2]?.steps[0]?.identity).toEqual({ host: HOST });
    expect(tools[3]).toMatchObject({ keys: ['command', 'description'], argClass: ['command', 'text'] });
    // A tool off the pinned lists sends the names that pass the gate, and its values go nowhere.
    expect(tools[4]).toMatchObject({ keys: ['query', 'quokka_key'], argClass: ['number', 'text'] });
    const reparsed = parseSkeleton(clone(skeleton));
    expect(reparsed.ok ? 'ok' : reparsed).toBe('ok');
  });
});

describe('through the store', () => {
  it('a skeleton-derived store holds the keys, the target class, and the argument classes the wire carried', () => {
    const skeleton = oneCall('Read', { keys: ['file_path', 'offset'], targetClass: 'doc', argClass: ['number', 'path'] });
    const parsed = parseSkeleton(clone(skeleton));
    if (!parsed.ok) throw new Error('refused');
    const record = storeOf([parsed.skeleton]).tools[0];
    expect(record).toMatchObject({ keys: ['file_path', 'offset'], targetClass: 'doc', argClass: ['number', 'path'], target: null, targetBase: null });
  });

  it('holds empty keys and no classes for a call that sent none', () => {
    const parsed = parseSkeleton(clone(oneCall('Read')));
    if (!parsed.ok) throw new Error('refused');
    const record = storeOf([parsed.skeleton]).tools[0];
    expect(record?.keys).toEqual([]);
    expect(record).not.toHaveProperty('targetClass');
    expect(record).not.toHaveProperty('argClass');
  });
});
