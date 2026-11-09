// The additive wire (conclusion section 17, rules 1 to 4): versions on every batch, an extensions bag for a field this reader does not know, and `other` for a value it does not know.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BATCH_FIELDS } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
import { FRAMEWORKS, LITERAL } from './public-vocabulary.js';
import { FIELD_LIST_VERSION, parseSkeleton, skeletonOf, SKELETON_FORMAT, VOCAB_VERSION, type SessionSkeleton } from './pool-wire.js';

const framed = frame({ shell: 'bash' });

const baseSkeleton = (): SessionSkeleton => {
  const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [], pulls: [{ registry: 'npm', name: 'vitest', version: '4.0.0' }] } });
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

interface Holder {
  [key: string]: unknown;
}
const isHolder = (value: unknown): value is Holder => typeof value === 'object' && value !== null;

/** A deep copy of a batch as plain JSON, which a test then edits as a client's own newer form would differ from this one. */
const wire = (): Holder => {
  const copy: unknown = JSON.parse(JSON.stringify(baseSkeleton()));
  if (!isHolder(copy)) throw new Error('a batch is an object');
  return copy;
};
/** A batch with one top-level field left off, as an older client would send it. */
const without = (name: string): Holder => {
  const sent = wire();
  Reflect.deleteProperty(sent, name);
  return sent;
};

const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((held, key) => (isHolder(held) ? held[String(key)] : undefined), value);
const holderAt = (value: unknown, ...path: (string | number)[]): Holder => {
  const found = at(value, ...path);
  if (!isHolder(found)) throw new Error(`no object at ${path.join('.')}`);
  return found;
};
const set = (value: unknown, path: (string | number)[], next: unknown): void => {
  holderAt(value, ...path.slice(0, -1))[String(path.at(-1))] = next;
};

const parsed = (value: unknown) => {
  const result = parseSkeleton(value);
  if (!result.ok) throw new Error(`${result.field}: ${result.reason}`);
  return result;
};

describe('versions on every batch', () => {
  it('stamps format 4, the vocabulary version, and the field-list version on a built batch and keeps them through the parser', () => {
    const built = baseSkeleton();
    expect(SKELETON_FORMAT).toBe(4);
    expect(built).toMatchObject({ format: 4, vocabVersion: VOCAB_VERSION, fieldsVersion: FIELD_LIST_VERSION });
    expect(parsed(JSON.parse(JSON.stringify(built))).skeleton).toMatchObject({ format: 4, vocabVersion: VOCAB_VERSION, fieldsVersion: FIELD_LIST_VERSION });
  });

  it('refuses format 2 by name, the way it refuses format 1', () => {
    for (const format of [1, 2]) {
      const sent = { ...wire(), format };
      const named: unknown = expect.stringContaining(`format ${String(format)}`);
      expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'format', reason: named });
    }
    expect(parseSkeleton({ ...wire(), format: 5 })).toMatchObject({ ok: false, field: 'format' });
  });

  it('refuses a batch whose versions are missing or of the wrong shape', () => {
    expect(parseSkeleton(without('vocabVersion'))).toMatchObject({ ok: false, field: 'vocabVersion', reason: 'missing' });
    expect(parseSkeleton(without('fieldsVersion'))).toMatchObject({ ok: false, field: 'fieldsVersion', reason: 'missing' });
    expect(parseSkeleton({ ...wire(), fieldsVersion: 'one' })).toMatchObject({ ok: false, field: 'fieldsVersion', reason: 'not a count' });
    expect(parseSkeleton({ ...wire(), vocabVersion: 'a version with spaces and a very long tail that no vocabulary would ever carry' })).toMatchObject({ ok: false, field: 'vocabVersion' });
  });

  it('accepts a newer field-list or vocabulary version than this reader holds, so an older server reads a newer client', () => {
    const result = parsed({ ...wire(), fieldsVersion: FIELD_LIST_VERSION + 5, vocabVersion: '99' });
    expect(result.skeleton).toMatchObject({ fieldsVersion: FIELD_LIST_VERSION + 5, vocabVersion: '99' });
  });
});

// The pin: the field names a batch holds, hashed, filed under the field-list version. Adding a field changes the hash, so the test fails until the version moves and the new pin is added beside the old.
const FIELDS_PINNED: { readonly [version: number]: string } = { 1: '3bf238006c97c800', 2: '9ddaff511a5a8342', 3: '4f59ec59f40accb5', 4: 'dcd086e0971b7948', 5: 'dc85267df48b42cb', 6: '6b58bf15c7c5f639', 7: 'a3348890aa46b605', 8: 'adbb805b0b3eda6d', 9: '9f365e370101f49a', 10: '97920d357be8ceae' };
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

  it('refuses an unknown field whose value is over 8 KiB as too large at its path, and takes one at the limit', () => {
    // The limit is on the field's own bytes as JSON, so it holds whatever the deposit's own cap is.
    const atLimit = wire();
    set(atLimit, ['transcripts', 0, 'tools', 0, 'steps', 0, 'newerField'], 'x'.repeat(8 * 1024 - 2));
    expect(parsed(atLimit).extensions).toHaveLength(1);
    const over = wire();
    set(over, ['transcripts', 0, 'tools', 0, 'steps', 0, 'newerField'], 'x'.repeat(8 * 1024 - 1));
    expect(parseSkeleton(over)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].steps[0].newerField', reason: 'too large' });
    const nested = wire();
    set(nested, ['newerList'], Array.from({ length: 3000 }, (_, index) => index * 1000));
    expect(parseSkeleton(nested)).toMatchObject({ ok: false, field: 'newerList', reason: 'too large' });
  });

  it('refuses a literal over 8 KiB the same way', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'status'], 'other');
    set(sent, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 'x'.repeat(8 * 1024));
    expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].statusLiteral', reason: 'too large' });
  });

  it('takes a <field>Literal as a literal only beside an other; beside a known value it is an unknown field of its own', () => {
    const beside = wire();
    set(beside, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 'paused');
    expect(parsed(beside).extensions).toEqual([{ at: 'transcripts[0].tools[0].statusLiteral', kind: 'field', value: 'paused' }]);
    // Not a literal, so it need not be text.
    const numeric = wire();
    set(numeric, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 7);
    expect(parsed(numeric).extensions).toEqual([{ at: 'transcripts[0].tools[0].statusLiteral', kind: 'field', value: 7 }]);
    // The stem is an absent optional field: nothing says other, so it is a field too.
    const absent = wire();
    Reflect.deleteProperty(holderAt(absent, 'transcripts', 0, 'frame'), 'model');
    set(absent, ['transcripts', 0, 'frame', 'modelLiteral'], 'gpt-9');
    expect(parsed(absent).extensions).toEqual([{ at: 'transcripts[0].frame.modelLiteral', kind: 'field', value: 'gpt-9' }]);
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
    expect(parseSkeleton(without('id'))).toMatchObject({ ok: false, field: 'id', reason: 'missing' });
    expect(parseSkeleton([])).toMatchObject({ ok: false, field: 'skeleton' });
    const oversized = wire();
    set(oversized, ['transcripts', 0, 'tools', 0, 'durationMs'], Number.MAX_SAFE_INTEGER + 2);
    expect(parseSkeleton(oversized)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].durationMs' });
  });
});

describe('other for an unknown value', () => {
  // Every enumerated wire field: where it sits, and a value no vocabulary holds.
  const FIELDS: { name: string; path: (string | number)[]; value?: string }[] = [
    { name: 'transcript harness', path: ['transcripts', 0, 'harness'] },
    { name: 'frame harness', path: ['transcripts', 0, 'frame', 'harness'] },
    { name: 'frame harnessVersion', path: ['transcripts', 0, 'frame', 'harnessVersion'], value: 'not a name!' },
    { name: 'frame model', path: ['transcripts', 0, 'frame', 'model'], value: 'not a name!' },
    { name: 'frame effort', path: ['transcripts', 0, 'frame', 'effort'] },
    { name: 'frame platform', path: ['transcripts', 0, 'frame', 'platform'] },
    { name: 'frame shell', path: ['transcripts', 0, 'frame', 'shell'] },
    { name: 'stack size', path: ['transcripts', 0, 'frame', 'stack', 'size'] },
    { name: 'stack languages', path: ['transcripts', 0, 'frame', 'stack', 'languages', 0] },
    { name: 'stack frameworks', path: ['transcripts', 0, 'frame', 'stack', 'frameworks', 0] },
    { name: 'language share language', path: ['transcripts', 0, 'frame', 'stack', 'languageShares', 0, 'language'] },
    { name: 'subagent agentType', path: ['transcripts', 1, 'tools', 0, 'steps', 0, 'agentType'] },
    { name: 'prompt cls', path: ['transcripts', 0, 'prompts', 0, 'cls'] },
    { name: 'tool status', path: ['transcripts', 0, 'tools', 0, 'status'] },
    { name: 'step action', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'] },
    // A native name that is no name (a command line, say) is set aside; a name travels as it is, below.
    { name: 'step native', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'], value: 'not a name!' },
    { name: 'step status', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'status'] },
    { name: 'shell sub', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'sub'], value: 'not a name!' },
    { name: 'shell flag', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags', 0], value: 'not a name!' },
    { name: 'pull registry', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'registry'] },
    { name: 'pull version', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'version'] },
  ];

  const withEnough = (): Holder => {
    const sent = wire();
    // A frame the fixture leaves empty gets one entry each, so every list and nullable field above has a value to replace.
    set(sent, ['transcripts', 0, 'frame', 'stack', 'languages'], ['typescript']);
    set(sent, ['transcripts', 0, 'frame', 'stack', 'frameworks'], [[...FRAMEWORKS][0] ?? '']);
    set(sent, ['transcripts', 0, 'frame', 'stack', 'size'], 'm');
    set(sent, ['transcripts', 0, 'frame', 'stack', 'languageShares'], [{ language: 'typescript', languageShare: '10-50' }]);
    const subagent: unknown = JSON.parse(JSON.stringify(holderAt(sent, 'transcripts', 0)));
    if (!isHolder(subagent)) throw new Error('a transcript is an object');
    set(subagent, ['tools', 0, 'steps', 0, 'agentType'], 'custom');
    set(sent, ['transcripts', 1], subagent);
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags'], ['--force']);
    return sent;
  };

  it.each(FIELDS)('parses an unknown $name as other, counts it, and keeps it as sent in the bag', ({ path, value = 'a-value-no-vocabulary-holds' }) => {
    const sent = withEnough();
    set(sent, path, value);
    const result = parsed(sent);
    expect(at(result.skeleton, ...path)).toBe('other');
    expect(result.others).toBe(1);
    // The place of the unknown value comes first; a part of the step it leaves unread (the identity of an unknown action, the flags of an unknown program) is noted after it, also as sent.
    expect(result.extensions[0]).toEqual({ at: path.reduce<string>((place, key) => (typeof key === 'number' ? `${place}[${String(key)}]` : place === '' ? key : `${place}.${key}`), ''), kind: 'value', value });
    expect(result.extensions.every(({ kind }) => kind === 'value')).toBe(true);
  });

  // A long-tail name is not an unknown value: the pool assigns its class (thresholded or clear), so the reader takes it as it is and counts and bags nothing.
  it.each([
    { name: 'step native', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'] },
    { name: 'shell program', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'program'] },
    { name: 'pull name', path: ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'name'] },
  ])('takes a $name off any list as it is, with nothing counted and nothing kept in the bag', ({ path }) => {
    const sent = withEnough();
    // A version beside a name off the public list travels only as the literal.
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'pulls', 0, 'version'], LITERAL);
    // A program off the list holds no subcommand or flag the reader can check, so the fixture's are cleared.
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'sub'], null);
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags'], []);
    set(sent, path, 'a-name-no-list-holds');
    const result = parsed(sent);
    expect(at(result.skeleton, ...path)).toBe('a-name-no-list-holds');
    expect(result.others).toBe(0);
    expect(result.extensions).toEqual([]);
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
    set(wrong, ['transcripts', 0, 'tools', 0, 'status'], 'other');
    set(wrong, ['transcripts', 0, 'tools', 0, 'statusLiteral'], 7);
    expect(parseSkeleton(wrong)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].statusLiteral', reason: 'not text' });
  });

  it('notes the identity of a step whose action is unknown and sends none beside other', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'], 'browser.drive');
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0)).toMatchObject({ action: 'other', identity: null });
    expect(result.extensions.map(({ at: found, kind }) => `${kind}:${found}`)).toEqual(['value:transcripts[0].tools[0].steps[0].action', 'value:transcripts[0].tools[0].steps[0].identity']);
  });
});

describe('one parse owns its own bag', () => {
  it('keeps a parse begun inside another (a getter on the input) from touching the outer bag', () => {
    const sent = wire();
    set(sent, ['outerField'], 1);
    let inner: ReturnType<typeof parseSkeleton> | undefined;
    // Reading `statusNote` runs a whole parse of another batch while the outer one is between two of its fields.
    Object.defineProperty(holderAt(sent, 'transcripts', 0, 'tools', 0), 'statusNote', {
      enumerable: true,
      get: () => {
        const other = wire();
        set(other, ['innerField'], 2);
        inner = parseSkeleton(other);
        return 'noted';
      },
    });
    const outer = parsed(sent);
    expect(outer.extensions.map(({ at: found }) => found)).toEqual(['outerField', 'transcripts[0].tools[0].statusNote']);
    expect(inner).toMatchObject({ ok: true, extensions: [{ at: 'innerField', kind: 'field', value: 2 }] });
  });
});

describe('a transcript whose harness reads other', () => {
  it('takes each tool name as sent, being a name, and keeps it in no bag', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'a-harness-no-table-holds');
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0, 'native')).toBe('Bash');
    expect(result.extensions.map(({ at: found }) => found)).toEqual(['transcripts[0].harness']);
  });

  it('keeps an MCP tool name as sent in the bag, and reads the tool as the literal; the native name is a name and travels', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'a-harness-no-table-holds');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'], 'mcp.call');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'], 'mcp__acme__create_issue');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity'], { server: 'private', tool: 'create_issue' });
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0, 'identity')).toEqual({ server: 'private', tool: LITERAL });
    expect(result.extensions).toContainEqual({ at: 'transcripts[0].tools[0].steps[0].identity.tool', kind: 'value', value: 'create_issue' });
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0, 'native')).toBe('mcp__acme__create_issue');
  });

  it('keeps nothing for a name that is already other or private', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'a-harness-no-table-holds');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'], 'private');
    expect(parsed(sent).extensions.map(({ at: found }) => found)).toEqual(['transcripts[0].harness']);
  });

  it('keeps nothing for a native name that reads other', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'a-harness-no-table-holds');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'], 'other');
    expect(parsed(sent).extensions.map(({ at: found }) => found)).toEqual(['transcripts[0].harness']);
  });
});

describe('every push to the bag is bounded', () => {
  const big = 'x'.repeat(9 * 1024);
  it.each([
    ['an unknown harness', ['transcripts', 0, 'harness'], 'transcripts[0].harness'],
    ['an unknown model', ['transcripts', 0, 'frame', 'model'], 'transcripts[0].frame.model'],
    ['an unknown platform', ['transcripts', 0, 'frame', 'platform'], 'transcripts[0].frame.platform'],
  ])('refuses %s over 8 KiB as too large at its path', (_name, path, field) => {
    const sent = wire();
    set(sent, path, big);
    expect(parseSkeleton(sent)).toMatchObject({ ok: false, field, reason: 'too large' });
  });

  it('refuses the identity of an unknown action over 8 KiB as too large at its path', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'action'], 'browser.drive');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity'], { program: big });
    expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].steps[0].identity', reason: 'too large' });
  });

  it('refuses the flags of an unknown program over 8 KiB as too large at its path', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'program'], 'other');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'identity', 'flags'], [big]);
    expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].steps[0].identity.flags', reason: 'too large' });
  });

  it('refuses a native name over 8 KiB under an unknown harness', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'a-harness-no-table-holds');
    set(sent, ['transcripts', 0, 'tools', 0, 'steps', 0, 'native'], big);
    expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].steps[0].native', reason: 'too large' });
  });

  it('takes an unknown value at the limit', () => {
    const sent = wire();
    set(sent, ['transcripts', 0, 'harness'], 'x'.repeat(8 * 1024 - 2));
    expect(parsed(sent).others).toBe(1);
  });
});

describe('the client emits no literal', () => {
  it('builds a batch with no `Literal` field and no value outside the closed lists: its off-list names stay private', () => {
    const built = baseSkeleton();
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (isHolder(value)) {
        for (const [key, entry] of Object.entries(value)) {
          names.add(key);
          walk(entry);
        }
      }
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
    Reflect.deleteProperty(holderAt(sent, 'transcripts', 0, 'frame'), 'model');
    Reflect.deleteProperty(holderAt(sent, 'transcripts', 0, 'frame', 'stack'), 'languageShares');
    Reflect.deleteProperty(holderAt(sent, 'transcripts', 0, 'tools', 0, 'steps', 0), 'parent');
    delete sent.timingPrint;
    delete sent.deltas;
    const result = parsed(sent);
    expect(at(result.skeleton, 'transcripts', 0, 'frame', 'model')).toBeNull();
    expect(at(result.skeleton, 'transcripts', 0, 'frame', 'stack', 'languageShares')).toEqual([]);
    expect(at(result.skeleton, 'transcripts', 0, 'tools', 0, 'steps', 0, 'parent')).toBeNull();
    expect(result.skeleton).toMatchObject({ timingPrint: null, deltas: [] });
  });
});
