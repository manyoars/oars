// The additive wire (conclusion section 17, rules 1 to 4): versions on every batch, an extensions bag for a field this reader does not know, and `other` for a value it does not know.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BATCH_FIELDS } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
import { FRAMEWORKS } from './public-vocabulary.js';
import { FIELD_LIST_VERSION, parseSkeleton, skeletonOf, SKELETON_FORMAT, VOCAB_VERSION, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });

const baseSkeleton = (): SessionSkeleton => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [], pulls: [{ registry: 'npm', name: 'vitest', version: '4.0.0' }] } });
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

/** A deep copy of a batch as plain JSON, which a test then edits as a client's own newer form would differ from this one. */
const wire = (): { [key: string]: unknown } => JSON.parse(JSON.stringify(baseSkeleton())) as { [key: string]: unknown };

const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((held, key) => (held as { [key: string]: unknown })[String(key)], value);
const set = (value: unknown, path: (string | number)[], next: unknown): void => {
  const holder = at(value, ...path.slice(0, -1)) as { [key: string]: unknown };
  holder[String(path.at(-1))] = next;
};

const parsed = (value: unknown) => {
  const result = parseSkeleton(value);
  if (!result.ok) throw new Error(`${result.field}: ${result.reason}`);
  return result;
};

describe('versions on every batch', () => {
  it('stamps format 3, the vocabulary version, and the field-list version on a built batch and keeps them through the parser', () => {
    const built = baseSkeleton();
    expect(SKELETON_FORMAT).toBe(3);
    expect(built).toMatchObject({ format: 3, vocabVersion: VOCAB_VERSION, fieldsVersion: FIELD_LIST_VERSION });
    expect(parsed(JSON.parse(JSON.stringify(built))).skeleton).toMatchObject({ format: 3, vocabVersion: VOCAB_VERSION, fieldsVersion: FIELD_LIST_VERSION });
  });

  it('refuses format 2 by name, the way it refuses format 1', () => {
    for (const format of [1, 2]) {
      const sent = { ...wire(), format };
      expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'format', reason: expect.stringContaining(`format ${String(format)}`) as unknown });
    }
    expect(parseSkeleton({ ...wire(), format: 4 })).toMatchObject({ ok: false, field: 'format' });
  });

  it('refuses a batch whose versions are missing or of the wrong shape', () => {
    const { vocabVersion: _vocab, ...noVocab } = wire();
    expect(parseSkeleton(noVocab)).toMatchObject({ ok: false, field: 'vocabVersion', reason: 'missing' });
    const { fieldsVersion: _fields, ...noFields } = wire();
    expect(parseSkeleton(noFields)).toMatchObject({ ok: false, field: 'fieldsVersion', reason: 'missing' });
    expect(parseSkeleton({ ...wire(), fieldsVersion: 'one' })).toMatchObject({ ok: false, field: 'fieldsVersion', reason: 'not a count' });
    expect(parseSkeleton({ ...wire(), vocabVersion: 'a version with spaces and a very long tail that no vocabulary would ever carry' })).toMatchObject({ ok: false, field: 'vocabVersion' });
  });

  it('accepts a newer field-list or vocabulary version than this reader holds, so an older server reads a newer client', () => {
    const result = parsed({ ...wire(), fieldsVersion: FIELD_LIST_VERSION + 5, vocabVersion: '99' });
    expect(result.skeleton).toMatchObject({ fieldsVersion: FIELD_LIST_VERSION + 5, vocabVersion: '99' });
  });
});

// The pin: the field names a batch holds, hashed, filed under the field-list version. Adding a field changes the hash, so the test fails until the version moves and the new pin is added beside the old.
const FIELDS_PINNED: { readonly [version: number]: string } = { 1: '3bf238006c97c800' };
const fieldsHash = (): string => createHash('sha256').update(BATCH_FIELDS.join(',')).digest('hex').slice(0, 16);

describe('the field-list version', () => {
  it('names the current field list: a field added without moving the version fails here', () => {
    expect(FIELDS_PINNED[FIELD_LIST_VERSION]).toBe(fieldsHash());
  });

  it('holds one pin for each version up to the current, so an old pin is never rewritten', () => {
    expect(Object.keys(FIELDS_PINNED).map(Number)).toEqual(Array.from({ length: FIELD_LIST_VERSION }, (_, index) => index + 1));
  });
});

describe('the extensions bag', () => {
  const LEVELS: { level: string; path: (string | number)[] }[] = [
    { level: 'batch', path: [] },
    { level: 'transcript', path: ['transcripts', 0] },
    { level: 'frame', path: ['transcripts', 0, 'frame'] },
    { level: 'stack', path: ['transcripts', 0, 'frame', 'stack'] },
    { level: 'prompt', path: ['transcripts', 0, 'prompts', 0] },
    { level: 'usage', path: ['transcripts', 0, 'prompts', 0, 'usage'] },
    { level: 'tool', path: ['transcripts', 0, 'tools', 0] },
    { level: 'step', path: ['transcripts', 0, 'tools', 0, 'steps', 0] },
    { level: 'identity', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity'] },
    { level: 'pull', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0] },
  ];

  it.each(LEVELS)('keeps an unknown field at the $level level, and the rest of the batch parses as without it', ({ path }) => {
    const sent = wire();
    set(sent, [...path, 'newerField'], { nested: [1, 2, 3], note: 'kept' });
    const result = parsed(sent);
    const where = [...path, 'newerField'].reduce<string>((text, key) => (typeof key === 'number' ? `${text}[${String(key)}]` : text === '' ? key : `${text}.${key}`), '');
    expect(result.extensions).toEqual([{ at: where, kind: 'field', value: { nested: [1, 2, 3], note: 'kept' } }]);
    expect(result.skeleton).toEqual(parsed(wire()).skeleton);
    expect(JSON.stringify(result.skeleton)).not.toContain('newerField');
  });

  it('keeps unknown fields from several levels together, in the order they were met', () => {
    const sent = wire();
    set(sent, ['topLevel'], 1);
    set(sent, ['transcripts', 0, 'frame', 'region'], 'eu');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'retry'], true);
    expect(parsed(sent).extensions.map(({ at: found }) => found)).toEqual(['topLevel', 'transcripts[0].frame.region', 'transcripts[0].tools[0].steps[0].retry']);
  });

  it('holds nothing for a batch with no unknown field', () => {
    expect(parsed(wire())).toMatchObject({ extensions: [], others: 0 });
  });

  it('still refuses a shape error: a wrong type, a name that is no field name, a missing required field, and a body that is not an object', () => {
    const wrongType = wire();
    set(wrongType, ['transcripts', 0, 'tools', 0, 'side'], 'yes');
    expect(parseSkeleton(wrongType)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].side', reason: 'not a boolean' });
    const badName = wire();
    set(badName, ['x'.repeat(65)], 1);
    expect(parseSkeleton(badName)).toMatchObject({ ok: false, reason: 'not a field name' });
    const spaced = wire();
    set(spaced, ['a field'], 1);
    expect(parseSkeleton(spaced)).toMatchObject({ ok: false, reason: 'not a field name' });
    const { id: _id, ...missing } = wire();
    expect(parseSkeleton(missing)).toMatchObject({ ok: false, field: 'id', reason: 'missing' });
    expect(parseSkeleton([])).toMatchObject({ ok: false, field: 'skeleton' });
    const oversized = wire();
    set(oversized, ['transcripts', 0, 'tools', 0, 'durationMs'], Number.MAX_SAFE_INTEGER + 2);
    expect(parseSkeleton(oversized)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].durationMs' });
  });
});

describe('other for an unknown value', () => {
  // Every enumerated wire field: where it sits, and a value no vocabulary holds.
  const FIELDS: { name: string; path: (string | number)[]; expected?: unknown }[] = [
    { name: 'transcript harness', path: ['transcripts', 0, 'harness'] },
    { name: 'frame harness', path: ['transcripts', 0, 'frame', 'harness'] },
    { name: 'frame harnessVersion', path: ['transcripts', 0, 'frame', 'harnessVersion'] },
    { name: 'frame model', path: ['transcripts', 0, 'frame', 'model'] },
    { name: 'frame effort', path: ['transcripts', 0, 'frame', 'effort'] },
    { name: 'frame platform', path: ['transcripts', 0, 'frame', 'platform'] },
    { name: 'frame shell', path: ['transcripts', 0, 'frame', 'shell'] },
    { name: 'stack size', path: ['transcripts', 0, 'frame', 'stack', 'size'] },
    { name: 'stack languages', path: ['transcripts', 0, 'frame', 'stack', 'languages', 0] },
    { name: 'stack frameworks', path: ['transcripts', 0, 'frame', 'stack', 'frameworks', 0] },
    { name: 'prompt cls', path: ['transcripts', 0, 'prompts', 0, 'cls'] },
    { name: 'tool status', path: ['transcripts', 0, 'tools', 0, 'status'] },
    { name: 'step action', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'] },
    { name: 'step native', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'] },
    { name: 'step status', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'status'] },
    { name: 'shell program', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'program'] },
    { name: 'shell sub', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'sub'] },
    { name: 'shell flag', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags', 0] },
    { name: 'pull registry', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'registry'] },
    { name: 'pull name', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'name'] },
    { name: 'pull version', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'version'] },
  ];

  const withEnough = (): { [key: string]: unknown } => {
    const sent = wire();
    // A frame the fixture leaves empty gets one entry each, so every list and nullable field above has a value to replace.
    set(sent, ['transcripts', 0, 'frame', 'stack', 'languages'], ['typescript']);
    set(sent, ['transcripts', 0, 'frame', 'stack', 'frameworks'], [[...FRAMEWORKS][0] ?? '']);
    set(sent, ['transcripts', 0, 'frame', 'stack', 'size'], 'm');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags'], ['--force']);
    return sent;
  };

  it.each(FIELDS)('parses an unknown $name as other, counts it, and keeps the value in the bag', ({ path }) => {
    const sent = withEnough();
    set(sent, path, 'a-value-no-vocabulary-holds');
    const result = parsed(sent);
    expect(at(result.skeleton, ...path)).toBe('other');
    expect(result.others).toBe(1);
    expect(result.extensions.filter(({ kind }) => kind === 'value')).toEqual([expect.objectContaining({ kind: 'value', value: 'a-value-no-vocabulary-holds' })]);
  });

  it('takes an explicit other without counting it, and refuses a value of the wrong type', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'status'], 'other');
    expect(parsed(sent)).toMatchObject({ others: 0, extensions: [] });
    const wrong = wire();
    set(wrong, ['transcripts', 0, 'tools', 0, 'status'], 7);
    expect(parseSkeleton(wrong)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].status' });
  });

  it('counts each unknown value of a batch', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'status'], 'paused');
    set(sent, ['transcripts', 0, 'prompts', 0, 'cls'], 'dreaming');
    set(sent, ['transcripts', 0, 'frame', 'platform'], 'plan9');
    expect(parsed(sent).others).toBe(3);
  });

  it('accepts an optional literal beside other and keeps it in the bag, served by nothing', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'status'], 'other');
    set(sent, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 'paused');
    expect(parsed(sent).extensions).toEqual([{ at: 'transcripts[0].tools[0].statusLiteral', kind: 'literal', value: 'paused' }]);
    const wrong = wire();
    set(wrong, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 7);
    expect(parseSkeleton(wrong)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].statusLiteral', reason: 'not text' });
  });

  it('keeps the identity of a step whose action is unknown in the bag and sends none beside other', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'], 'browser.drive');
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0)).toMatchObject({ action: 'other', identity: null });
    expect(result.extensions.map(({ at: found, kind }) => `${kind}:${found}`)).toEqual(['value:transcripts[0].tools[0].steps[0].action', 'field:transcripts[0].tools[0].steps[0].identity']);
  });
});

describe('the client emits no literal', () => {
  it('builds a batch with no `Literal` field and no value outside the closed lists: its off-list names stay private', () => {
    const built = baseSkeleton();
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) for (const [key, entry] of Object.entries(value)) (names.add(key), walk(entry));
    };
    walk(built);
    expect([...names].filter((name) => name.endsWith('Literal'))).toEqual([]);
    expect(parsed(JSON.parse(JSON.stringify(built)))).toMatchObject({ others: 0, extensions: [] });
    expect(BATCH_FIELDS.filter((name) => name.endsWith('Literal'))).toEqual([]);
  });
});

describe('every optional field may be absent', () => {
  it('reads an absent nullable field as null and an absent list as empty', () => {
    const sent = wire();
    delete (at(sent, 'transcripts', 0, 'frame') as { [key: string]: unknown }).model;
    delete (at(sent, 'transcripts', 0, 'frame', 'stack') as { [key: string]: unknown }).languageShares;
    delete (at(sent, 'transcripts', 0, 'tools', 0, 'steps', 0) as { [key: string]: unknown }).parent;
    delete sent.timingPrint;
    delete sent.deltas;
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'frame', 'model')).toBeNull();
    expect(at(result.skeleton, 'transcripts', 0, 'frame', 'stack', 'languageShares')).toEqual([]);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0, 'parent')).toBeNull();
    expect(result.skeleton).toMatchObject({ timingPrint: null, deltas: [] });
  });
});
