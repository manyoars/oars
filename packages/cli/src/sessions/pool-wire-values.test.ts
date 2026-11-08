// Layer 1 of a call's parameters: what its values are like, never what they are. Per key, a value's size bucket and, for a path, its depth, extension class, and folder kind, for a pattern what it uses; the
// closed values (a boolean, a member of its tool's list); and what changed from the previous call of the same tool in the prompt. Every name and value here is invented.
import { describe, expect, it } from 'vitest';
import { argFeaturesOf, argValuesOf, changeKindOf, type ComparedCall } from './call-shape.js';
import { cellsOf, projectedStore, storeOf } from './cell-increments.js';
import { SHAPE_CLASS, shapeClass } from './cells.js';
import { captureSession } from './extract.js';
import { printOf, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { CLOSED_ARG_VALUES } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type, model: 'claude-opus-5-5', content } });
const call = (id: string, name: string, input: object): string => line('assistant', [{ type: 'tool_use', id, name, input }]);
const result = (id: string, failed: boolean): string => line('user', [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? 'boom' : 'done' }]);

const captured = (...lines: string[]) => captureSession({ text: [line('user', 'go'), ...lines].join('\n'), session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact });
const skeletonOfLines = (...lines: string[]): SessionSkeleton => {
  const held = captured(...lines);
  const [only] = sessionsFrom(store({ sessions: [held.session], prompts: [], tools: held.tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};
const toolsOf = (skeleton: SessionSkeleton) => skeleton.transcripts[0]?.tools ?? [];

describe('value features', () => {
  it('state a path by depth, extension class, and folder kind, below the working folder, and never above it', () => {
    expect(argFeaturesOf('Read', { file_path: '/w/src/app/main.ts', limit: 200 }, '/w')).toEqual([
      { key: 'file_path', valueSize: '9-32', pathDepth: '2', extension: 'source', dirKind: 'source' },
      { key: 'limit', valueSize: '1-8' },
    ]);
    expect(argFeaturesOf('Read', { file_path: '/home/someone/notes/plan.md' }, '/w')).toEqual([{ key: 'file_path', valueSize: '9-32', pathDepth: 'outside', extension: 'doc', dirKind: 'other' }]);
    expect(argFeaturesOf('Write', { file_path: 'README', content: '' }, '/w')).toEqual([
      { key: 'content', valueSize: '0' },
      { key: 'file_path', valueSize: '1-8', pathDepth: '0', extension: 'none', dirKind: 'root' },
    ]);
    expect(argFeaturesOf('Read', { file_path: 'tests/fixtures/rows.csv' }, '/w')[0]).toMatchObject({ pathDepth: '2', extension: 'data', dirKind: 'test' });
  });

  it('measures a relative path from the cwd, so it reads as the absolute path to the same file does', () => {
    const root = '/w';
    const cwd = '/w/packages/app';
    const relative = argFeaturesOf('Read', { file_path: 'src/ui/button.ts' }, root, cwd);
    const absolute = argFeaturesOf('Read', { file_path: '/w/packages/app/src/ui/button.ts' }, root, cwd);
    expect(relative).toEqual(absolute);
    expect(relative[0]).toMatchObject({ pathDepth: '3-4', extension: 'source', dirKind: 'source' });
    // The cwd is the root, or none is given: a relative path is measured as it stands.
    expect(argFeaturesOf('Read', { file_path: 'src/ui/button.ts' }, root, root)[0]).toMatchObject({ pathDepth: '2' });
    expect(argFeaturesOf('Read', { file_path: 'src/ui/button.ts' }, root)[0]).toMatchObject({ pathDepth: '2' });
    // A relative path that climbs out of the root names folders above it, as an absolute one does.
    expect(argFeaturesOf('Read', { file_path: '../../../etc/app.conf' }, root, cwd)[0]).toMatchObject({ pathDepth: 'outside', dirKind: 'other' });
    // A Windows cwd and root, and a `.` part.
    expect(argFeaturesOf('Read', { file_path: './src/a.ts' }, 'C:\\w', 'C:\\w\\pkg')[0]).toMatchObject({ pathDepth: '2' });
    // A Windows drive is kept, so a path that climbs above the repository root reads as outside it, as the posix form does.
    expect(argFeaturesOf('Read', { file_path: '../../../x' }, 'C:\\w', 'C:\\w\\pkg')[0]).toMatchObject({ pathDepth: 'outside', dirKind: 'other' });
    // An absolute path that climbs out of the root is outside it too, and a leading `~` is a home folder that `..` does not pop.
    expect(argFeaturesOf('Read', { file_path: '/w/../etc/passwd' }, '/w', '/w')[0]).toMatchObject({ pathDepth: 'outside', dirKind: 'other' });
    expect(argFeaturesOf('Read', { file_path: '/w/src/../a.ts' }, '/w', '/w')[0]).toMatchObject({ pathDepth: '0', dirKind: 'root', extension: 'source' });
    expect(argFeaturesOf('Read', { file_path: '~/../../x' }, '/w', '/w')[0]).toMatchObject({ pathDepth: 'outside', dirKind: 'other' });
    // The repository root itself, as a dot, an absolute path, or one with a trailing slash, is one answer: no folders below the root.
    for (const value of ['.', '/w', '/w/']) expect(argFeaturesOf('Glob', { path: value }, '/w', '/w')[0], value).toMatchObject({ pathDepth: '0', dirKind: 'root', extension: 'none' });
  });

  it('state a pattern by what it uses, as a regular expression or, for Glob and a glob key, as a glob', () => {
    expect(argFeaturesOf('Grep', { pattern: '^(foo|ba[rz])\\.ts$' }, '/w')[0]?.patternFeatures).toEqual(['alternation', 'anchor', 'class', 'escape', 'group']);
    expect(argFeaturesOf('Grep', { pattern: 'plainword' }, '/w')[0]?.patternFeatures).toEqual(['literal']);
    expect(argFeaturesOf('Grep', { pattern: 'a.*b', glob: '*.{ts,tsx}' }, '/w')).toEqual([
      { key: 'glob', valueSize: '9-32', patternFeatures: ['alternation', 'wildcard'] },
      { key: 'pattern', valueSize: '1-8', patternFeatures: ['quantifier', 'wildcard'] },
    ]);
    expect(argFeaturesOf('Glob', { pattern: 'src/**/*.ts' }, '/w')[0]?.patternFeatures).toEqual(['recursive', 'wildcard']);
  });

  it('size every value but a boolean and a null, as written', () => {
    expect(argFeaturesOf('Bash', { command: 'x'.repeat(9000), run_in_background: true, timeout: null }, '/w')).toEqual([{ key: 'command', valueSize: 'over-8k' }]);
    expect(argFeaturesOf('TodoWrite', { todos: [{ content: 'a' }] }, '/w')).toEqual([{ key: 'todos', valueSize: '9-32' }]);
  });

  it('put a secret-looking value on the wire as features only: no part of it is in the batch', () => {
    const SECRET = 'ghp_Q7zV2mXk9LpR4tW8yB3nC6dF1hJ5sA0e';
    const skeleton = skeletonOfLines(call('t1', 'Grep', { pattern: `token=${SECRET}`, path: `src/${SECRET}` }), call('t2', 'Write', { file_path: `/w/docs/${SECRET}.md`, content: SECRET }));
    const batch = JSON.stringify(skeleton);
    for (let at = 0; at + 5 <= SECRET.length; at += 1) expect(batch).not.toContain(SECRET.slice(at, at + 5));
    const [grep, write] = toolsOf(skeleton);
    expect(grep?.argFeatures).toEqual([
      { key: 'path', valueSize: '33-128', pathDepth: '1', extension: 'none', dirKind: 'source' },
      { key: 'pattern', valueSize: '33-128', patternFeatures: ['literal'] },
    ]);
    expect(write?.argFeatures).toEqual([
      { key: 'content', valueSize: '33-128' },
      { key: 'file_path', valueSize: '33-128', pathDepth: '1', extension: 'doc', dirKind: 'doc' },
    ]);
    expect(parseSkeleton(structuredClone(skeleton)).ok).toBe(true);
  });

  it('send a feature only for a key the call sent, and count it in a shape cell keyed on that key', () => {
    const skeleton = skeletonOfLines(call('t1', 'Read', { file_path: 'src/a.ts', acme_private_flag: 'x' }));
    expect(toolsOf(skeleton)[0]?.argFeatures?.map(({ key }) => key)).toEqual(['file_path']);
    const parsed = parseSkeleton(structuredClone(skeleton));
    if (!parsed.ok) throw new Error('refused');
    const cells = cellsOf(storeOf([parsed.skeleton]));
    const names = cells.motifs.map(({ cls }) => cls ?? '').filter((cls) => cls.startsWith(SHAPE_CLASS));
    expect(names).toEqual(expect.arrayContaining([shapeClass('file.read', 'depth', 'file_path=1'), shapeClass('file.read', 'extension', 'file_path=source'), shapeClass('file.read', 'size', 'file_path=1-8')]));
    expect(names.some((cls) => cls.includes('acme_private_flag'))).toBe(false);
  });

  it('refuse a feature naming a key the call did not send', () => {
    const skeleton = skeletonOfLines(call('t1', 'Read', { file_path: 'src/a.ts' }));
    const only = toolsOf(skeleton)[0];
    if (only === undefined) throw new Error('no call');
    only.argFeatures = [{ key: 'offset', valueSize: '1-8' }];
    expect(parseSkeleton(skeleton)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].argFeatures[0].key' });
  });

  it('read a feature off its closed list as other', () => {
    const skeleton = structuredClone(skeletonOfLines(call('t1', 'Read', { file_path: 'src/a.ts' })));
    Reflect.set(toolsOf(skeleton)[0]?.argFeatures?.[0] ?? {}, 'pathDepth', 'brand-new-depth');
    expect(parseSkeleton(skeleton)).toMatchObject({ ok: true, others: 1 });
  });
});

describe('closed values', () => {
  it('hold every boolean and each string its tool lists for the key, and nothing else', () => {
    expect(argValuesOf('Edit', { file_path: 'a', old_string: 'b', new_string: 'c', replace_all: true }, CLOSED_ARG_VALUES)).toEqual([{ key: 'replace_all', enumValue: 'true' }]);
    expect(argValuesOf('Grep', { pattern: 'x', output_mode: 'count', multiline: false }, CLOSED_ARG_VALUES)).toEqual([
      { key: 'multiline', enumValue: 'false' },
      { key: 'output_mode', enumValue: 'count' },
    ]);
    expect(argValuesOf('Agent', { subagent_type: 'Explore', prompt: 'look' }, CLOSED_ARG_VALUES)).toEqual([{ key: 'subagent_type', enumValue: 'Explore' }]);
    expect(argValuesOf('Agent', { subagent_type: 'acme-reviewer', prompt: 'look' }, CLOSED_ARG_VALUES)).toEqual([]);
  });

  it('send a built-in subagent type and never a custom agent name', () => {
    const skeleton = skeletonOfLines(call('t1', 'Agent', { subagent_type: 'Explore', prompt: 'p', run_in_background: true }), call('t2', 'Agent', { subagent_type: 'acme-reviewer', prompt: 'p' }));
    const [builtIn, custom] = toolsOf(skeleton);
    expect(builtIn?.argValues).toEqual([
      { key: 'run_in_background', enumValue: 'true' },
      { key: 'subagent_type', enumValue: 'Explore' },
    ]);
    expect(custom).not.toHaveProperty('argValues');
    expect(JSON.stringify(skeleton)).not.toContain('acme-reviewer');
  });

  it('read a value off the list as other and keep it in the bag, so the pool serves nothing from it', () => {
    const skeleton = structuredClone(skeletonOfLines(call('t1', 'Grep', { pattern: 'x', output_mode: 'count' })));
    Reflect.set(toolsOf(skeleton)[0]?.argValues?.[0] ?? {}, 'enumValue', 'acme-mode');
    const parsed = parseSkeleton(skeleton);
    expect(parsed).toMatchObject({ ok: true, others: 1 });
    if (parsed.ok) expect(parsed.skeleton.transcripts[0]?.tools[0]?.argValues).toEqual([{ key: 'output_mode', enumValue: 'other' }]);
  });
});

describe('change kind', () => {
  const compared = (input: { [key: string]: unknown }, target: string | null = null): ComparedCall => ({ input, target, features: argFeaturesOf('Bash', input, '/w'), values: argValuesOf('Bash', input, CLOSED_ARG_VALUES) });

  it('names what changed from the previous call of the tool, or same', () => {
    expect(changeKindOf(compared({ command: 'npm test' }), compared({ command: 'npm test' }))).toEqual(['same']);
    expect(changeKindOf(compared({ command: 'npm test' }), compared({ command: 'npm test', timeout: 600000 }))).toEqual(['key-added']);
    expect(changeKindOf(compared({ command: 'npm test', timeout: 1 }), compared({ command: 'npm test' }))).toEqual(['key-removed']);
    expect(changeKindOf(compared({ command: 'npm test' }), compared({ command: 'npm run test:unit -- --reporter dot' }))).toEqual(['feature-changed']);
    expect(changeKindOf(compared({ command: 'npm test' }), compared({ command: 'npm tst' }))).toEqual(['value-changed']);
    expect(changeKindOf(compared({ run_in_background: false }), compared({ run_in_background: true }))).toEqual(['feature-changed']);
    expect(changeKindOf(compared({ command: 'npm test' }, 'npm/test'), compared({ command: 'npm test' }, 'npm/run'))).toEqual(['target-changed']);
  });

  it('marks a retry after a failed call, and that retry counts in a change cell by its own status', () => {
    const skeleton = skeletonOfLines(
      call('t1', 'Bash', { command: 'npm test' }),
      result('t1', true),
      call('t2', 'Read', { file_path: 'src/a.ts' }),
      result('t2', false),
      call('t3', 'Bash', { command: 'npm test', timeout: 600000 }),
      result('t3', false),
    );
    const [failed, between, retry] = toolsOf(skeleton);
    expect(failed?.status).toBe('error');
    expect(failed).not.toHaveProperty('changeKind');
    expect(between).not.toHaveProperty('changeKind');
    expect(retry).toMatchObject({ status: 'ok', changeKind: ['key-added'] });
    const parsed = parseSkeleton(structuredClone(skeleton));
    if (!parsed.ok) throw new Error('refused');
    const set = cellsOf(storeOf([parsed.skeleton]));
    const motif = set.motifs.find(({ cls }) => cls === shapeClass('shell.exec', 'change', 'key-added'));
    expect(set.cells.filter(({ motifId }) => motifId === motif?.motifId).map(({ ok, failed: failedCount }) => [ok, failedCount])).toEqual([[1, 0]]);
  });

  it('are the same shape cells at the pool as on the machine', () => {
    const held = captured(call('t1', 'Bash', { command: 'npm test' }), result('t1', true), call('t2', 'Bash', { command: 'npm test', timeout: 9 }), result('t2', false), call('t3', 'Grep', { pattern: '^x', output_mode: 'count' }));
    const local = store({ sessions: [held.session], prompts: [], tools: held.tools });
    const skeleton = skeletonOfLines(call('t1', 'Bash', { command: 'npm test' }), result('t1', true), call('t2', 'Bash', { command: 'npm test', timeout: 9 }), result('t2', false), call('t3', 'Grep', { pattern: '^x', output_mode: 'count' }));
    const parsed = parseSkeleton(structuredClone(skeleton));
    if (!parsed.ok) throw new Error('refused');
    const names = (set: ReturnType<typeof cellsOf>): string[] => set.motifs.map(({ cls }) => cls ?? '').filter((cls) => cls.startsWith(SHAPE_CLASS)).sort();
    expect(names(cellsOf(storeOf([parsed.skeleton])))).toEqual(names(cellsOf(projectedStore(local, storedNames))));
    expect(names(cellsOf(projectedStore(local, storedNames)))).toEqual(expect.arrayContaining([shapeClass('file.search', 'enum', 'output_mode=count'), shapeClass('file.search', 'pattern', 'pattern=anchor')]));
  });
});
