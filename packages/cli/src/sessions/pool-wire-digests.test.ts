// Format 7: a call may carry `digests`, the digest of the old and new text of an Edit, MultiEdit, or Write, so an edit that restores earlier content can be told from one that does not. The digest is plain and
// the same text matches across sessions. A `git restore` names its path the way an edit does, in `names`. The pool reads formats 3 to 7, and a `digests` list in an older batch is a field its format does not define.
// Every text here is invented.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { printOf, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { BATCH_FIELDS, FIELD_ROWS } from './pool-outbox.js';
import { EXPOSURE_FORMAT, FORMAT_7_TOOL_FIELDS, OPTIONAL, parseSkeleton, READ_FORMATS, skeletonOf, SKELETON_FORMAT, wireDigests, type SessionSkeleton, type SkeletonTool } from './pool-wire.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown, cwd = '/w'): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: type, model: 'claude-opus-5-5', content } });
const call = (id: string, name: string, input: object, cwd = '/w'): string => line('assistant', [{ type: 'tool_use', id, name, input }], cwd);
const result = (id: string): string => line('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

const skeletonOfLines = (...lines: string[]): SessionSkeleton => {
  const held = captureSession({ text: [line('user', 'go'), ...lines].join('\n'), session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact, harness: 'claude-code' });
  const [only] = sessionsFrom(store({ sessions: [held.session], prompts: [], tools: held.tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], { redact, terms: [] });
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};
const toolsOf = (skeleton: SessionSkeleton): SkeletonTool[] => skeleton.transcripts[0]?.tools ?? [];
/** What the pool reads of a batch after it has been through JSON, as it travels. */
const parsedTools = (skeleton: SessionSkeleton): SkeletonTool[] => {
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
  if (!parsed.ok) throw new Error(parsed.reason);
  return toolsOf(parsed.skeleton);
};

describe('the digests of an edit on the wire', () => {
  it('sends the one old and new pair of an Edit, and the pool reads it back', () => {
    const skeleton = skeletonOfLines(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'let a = 1;', new_string: 'let a = 2;' }), result('e1'));
    const expected = [{ old: digestOf('let a = 1;'), new: digestOf('let a = 2;') }];
    expect(toolsOf(skeleton)[0]?.digests).toEqual(expected);
    expect(parsedTools(skeleton)[0]?.digests).toEqual(expected);
  });

  it('sends one pair for each edit of a MultiEdit, in order', () => {
    const skeleton = skeletonOfLines(call('m1', 'MultiEdit', { file_path: '/w/a.ts', edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'two', new_string: 'three' }] }), result('m1'));
    const expected = [{ old: digestOf('one'), new: digestOf('two') }, { old: digestOf('two'), new: digestOf('three') }];
    expect(toolsOf(skeleton)[0]?.digests).toEqual(expected);
    expect(parsedTools(skeleton)[0]?.digests).toEqual(expected);
  });

  it('sends a new digest alone for a Write: no old digest, and never the digest of an empty string', () => {
    const skeleton = skeletonOfLines(call('w1', 'Write', { file_path: '/w/a.ts', content: 'export const a = 1;\n' }), result('w1'));
    const [sent] = toolsOf(skeleton)[0]?.digests ?? [];
    expect(sent).toEqual({ new: digestOf('export const a = 1;\n') });
    expect(sent).not.toHaveProperty('old');
    const [read] = parsedTools(skeleton)[0]?.digests ?? [];
    expect(read).toEqual({ new: digestOf('export const a = 1;\n') });
    expect(read).not.toHaveProperty('old');
  });

  it('sends none for a tool that is no edit, and the parse holds none either', () => {
    const skeleton = skeletonOfLines(call('r1', 'Read', { file_path: '/w/a.ts' }), result('r1'));
    expect(toolsOf(skeleton)[0]).not.toHaveProperty('digests');
    expect(parsedTools(skeleton)[0]).not.toHaveProperty('digests');
  });

  it('sends the same digest for the same text in two sessions: the digest is plain, not keyed', () => {
    const first = skeletonOfLines(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }));
    const second = skeletonOfLines(call('e9', 'Edit', { file_path: '/elsewhere/b.ts', old_string: 'x', new_string: 'y' }));
    expect(toolsOf(first)[0]?.digests).toEqual(toolsOf(second)[0]?.digests);
  });

  it('sends the path a git restore names as the file and folder names of the call, as an edit sends its path', () => {
    const edit = skeletonOfLines(call('e1', 'Edit', { file_path: '/w/src/billing/ledger.ts', old_string: 'x', new_string: 'y' }));
    const restore = skeletonOfLines(call('b1', 'Bash', { command: 'git restore src/billing/ledger.ts' }), result('b1'));
    const wanted = [{ kind: 'dir', name: 'billing' }, { kind: 'dir', name: 'src' }, { kind: 'file', name: 'ledger.ts' }];
    const named = (tool: SkeletonTool | undefined) => (tool?.names ?? []).filter(({ name }) => ['billing', 'src', 'ledger.ts'].includes(name)).sort((a, b) => a.name.localeCompare(b.name));
    expect(named(toolsOf(edit)[0])).toEqual(wanted.sort((a, b) => a.name.localeCompare(b.name)));
    expect(named(toolsOf(restore)[0])).toEqual(named(toolsOf(edit)[0]));
    expect(named(parsedTools(restore)[0])).toEqual(named(toolsOf(edit)[0]));
  });
});

describe('format 7 and the formats before it', () => {
  it('builds format 7 and reads formats 3 to 7, and names the exposure format', () => {
    expect(SKELETON_FORMAT).toBe(7);
    expect(READ_FORMATS).toEqual([3, 4, 5, 6, 7]);
    expect(EXPOSURE_FORMAT).toBe(6);
    expect(FORMAT_7_TOOL_FIELDS).toEqual(['digests']);
    expect(skeletonOfLines(call('r1', 'Read', { file_path: '/w/a.ts' })).format).toBe(7);
  });

  it('reads a format 6 batch as before: a digests list in it is a field format 6 does not define, so it goes to the bag', () => {
    const sent = JSON.parse(JSON.stringify(skeletonOfLines(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })))) as SessionSkeleton;
    const parsed = parseSkeleton({ ...sent, format: 6, fieldsVersion: 12 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.format).toBe(6);
    expect(toolsOf(parsed.skeleton)[0]).not.toHaveProperty('digests');
    expect(parsed.extensions.map(({ at, kind }) => `${kind} ${at}`)).toEqual(['field transcripts[0].tools[0].digests']);
  });

  it.each([5, 4, 3])('puts a digests list in a batch of format %i into the bag too', (format) => {
    const sent = JSON.parse(JSON.stringify(skeletonOfLines(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })))) as SessionSkeleton;
    const parsed = parseSkeleton({ ...sent, format });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(toolsOf(parsed.skeleton)[0]).not.toHaveProperty('digests');
    expect(parsed.extensions.map(({ at }) => at)).toContain('transcripts[0].tools[0].digests');
  });

  it('reads a format 6 batch that holds no digests with no bag at all', () => {
    const sent = JSON.parse(JSON.stringify(skeletonOfLines(call('r1', 'Read', { file_path: '/w/a.ts' })))) as SessionSkeleton;
    expect(parseSkeleton({ ...sent, format: 6 })).toMatchObject({ ok: true, others: 0, extensions: [], skeleton: { format: 6 } });
  });

  it('reads the recommendations of a format 6 batch and a format 7 batch, and not those of format 5', () => {
    const base = JSON.parse(JSON.stringify(skeletonOfLines(call('r1', 'Read', { file_path: '/w/a.ts' })))) as SessionSkeleton;
    const withRow = { ...base, recommendations: [{ id: 'a'.repeat(16), arm: 'shown', poolVersion: 'v1', from: 0, to: 1 }] };
    for (const format of [6, 7]) expect(parseSkeleton({ ...withRow, format })).toMatchObject({ ok: true, skeleton: { recommendations: [{ arm: 'shown' }] } });
    const older = parseSkeleton({ ...withRow, format: 5 });
    if (!older.ok) throw new Error(older.reason);
    expect(older.skeleton.recommendations).toBeUndefined();
  });

  it('lists digests among the fields a tool may carry, and registers its three field names', () => {
    expect(OPTIONAL.tool).toContain('digests');
    for (const name of ['digests', 'old', 'new']) {
      expect(BATCH_FIELDS).toContain(name);
      expect(FIELD_ROWS[name]).toMatch(/digest|text/);
    }
  });
});

describe('a digest the pool refuses', () => {
  const edited = (): SessionSkeleton => JSON.parse(JSON.stringify(skeletonOfLines(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })))) as SessionSkeleton;
  const withDigest = (digest: unknown): unknown => {
    const skeleton = edited();
    Object.assign(skeleton.transcripts[0]?.tools[0] ?? {}, { digests: [digest] });
    return skeleton;
  };

  it.each([
    ['a digest that is not hex', { old: 'z'.repeat(32), new: digestOf('y') }, 'transcripts[0].tools[0].digests[0].old'],
    ['a digest that is too short', { old: digestOf('x'), new: digestOf('y').slice(0, 31) }, 'transcripts[0].tools[0].digests[0].new'],
    ['a digest in capitals', { old: digestOf('x').toUpperCase(), new: digestOf('y') }, 'transcripts[0].tools[0].digests[0].old'],
    ['text in place of a digest', { old: 'let a = 1;', new: digestOf('y') }, 'transcripts[0].tools[0].digests[0].old'],
    ['a pair with no new digest', { old: digestOf('x') }, 'transcripts[0].tools[0].digests[0].new'],
    ['a pair that is no object', 'x', 'transcripts[0].tools[0].digests[0]'],
  ])('refuses %s', (_label, digest, field) => {
    expect(parseSkeleton(withDigest(digest))).toMatchObject({ ok: false, field });
  });

  it('refuses a digests list that is no list', () => {
    const skeleton = edited();
    Object.assign(skeleton.transcripts[0]?.tools[0] ?? {}, { digests: 'x' });
    expect(parseSkeleton(skeleton)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].digests' });
  });

  it('keeps a field this reader does not know in a digest pair in the bag', () => {
    const parsed = parseSkeleton(withDigest({ old: digestOf('x'), new: digestOf('y'), newer: 1 }));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.extensions.map(({ at }) => at)).toEqual(['transcripts[0].tools[0].digests[0].newer']);
  });
});

describe('the digests the client sends', () => {
  it('drops a stored pair whose digest is not the shape capture writes, so a corrupt row costs the pair and never the deposit', () => {
    const good = { old: digestOf('a'), new: digestOf('b') };
    expect(wireDigests(undefined)).toEqual([]);
    expect(wireDigests([good, { old: 'not a digest', new: digestOf('b') }, { new: 'ABC' }, { new: digestOf('c') }])).toEqual([good, { new: digestOf('c') }]);
  });
});
