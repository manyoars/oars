import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../cli.js';
import { writeGoldFiles } from './command.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { captureSession } from './extract.js';
import { armsPath, auroc, drawSample, formatScore, frameOf, parseGold, readTurns, renderGold, scoreGold, viewOf, type GoldEntry, type GoldView } from './gold.js';
import { makeRedactor } from './redact.js';
import type { PromptObservation } from './schema.js';
import { addProject, cleanup, FIXTURES, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const redact = makeRedactor();
const line = (value: object): string => JSON.stringify(value);
const user = (text: string): string => line({ type: 'user', timestamp: '2026-06-01T00:00:00Z', cwd: '/w', message: { role: 'user', content: text } });
const said = (text: string): string => line({ type: 'assistant', requestedModel: 'm-a', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (id: string, name: string, input: object): string => line({ type: 'assistant', cwd: '/w', requestedModel: 'm-a', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, isError = false): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

const prompt = (session: string, index: number, cls: PromptObservation['cls'], model: string, extra: Partial<PromptObservation> = {}): PromptObservation => ({
  kind: 'prompt',
  v: '5',
  session,
  rev: 1,
  index,
  ts: null,
  wallSec: null,
  head: `request ${session} ${String(index)}`,
  cls,
  tools: [],
  shape: '',
  errors: 0,
  thinking: 0,
  sideTools: 0,
  turns: 1,
  model,
  efforts: [],
  skills: [],
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 },
  recovery: [],
  explore: 0,
  act: 0,
  bigrams: {},
  contextFingerprint: null,
  verify: 'none',
  stopped: null,
  commits: 0,
  redo: false,
  ...extra,
});

const accepted = (): Promise<boolean> => Promise.resolve(true);

describe('frameOf', () => {
  it('keeps prompts with signals and something to show', () => {
    const kept = prompt('a', 0, 'edit-only', 'm-a');
    const interrupted = prompt('a', 1, 'edit-only', 'm-a', { head: '[Request interrupted by user]' });
    const silent = prompt('b', 0, 'no-tools', 'm-a');
    const cursor = prompt('cursor-1', 0, 'edit-only', 'm-a');
    const codex = prompt('codex-1', 0, 'edit-only', 'm-a');
    const noSignals = prompt('c', 0, 'edit-only', 'm-a', { verify: undefined });
    const noModel = prompt('d', 0, 'edit-only', '');
    expect(frameOf([kept, interrupted, silent, cursor, codex, noSignals, noModel])).toEqual([kept]);
  });
});

describe('drawSample', () => {
  const population = (): PromptObservation[] => {
    const prompts: PromptObservation[] = [];
    for (let n = 0; n < 300; n += 1) prompts.push(prompt(`big${String(n)}`, 0, 'edit-only', 'm-big'));
    for (let n = 0; n < 40; n += 1) prompts.push(prompt(`mid${String(n)}`, 0, 'shell-only', 'm-big'));
    for (let n = 0; n < 12; n += 1) prompts.push(prompt(`small${String(n)}`, 0, 'research', 'm-small'));
    return prompts;
  };

  it('reaches every class and model, not only the largest', async () => {
    const picked = await drawSample(population(), 50, 'seed', accepted);
    expect(picked).toHaveLength(50);
    expect(new Set(picked.map((item) => item.cls))).toEqual(new Set(['edit-only', 'shell-only', 'research']));
    expect(new Set(picked.map((item) => item.model))).toEqual(new Set(['m-big', 'm-small']));
    // Square-root weights: the small cell gets more than its 3% share, and the big cell still gets the most.
    const count = (cls: string): number => picked.filter((item) => item.cls === cls).length;
    expect(count('research')).toBeGreaterThan(2);
    expect(count('edit-only')).toBeGreaterThan(count('shell-only'));
  });

  it('is the same draw for one seed and another draw for another', async () => {
    const ids = async (seed: string): Promise<string[]> => (await drawSample(population(), 30, seed, accepted)).map((item) => `${item.session}:${String(item.index)}`);
    expect(await ids('one')).toEqual(await ids('one'));
    expect(await ids('one')).not.toEqual(await ids('two'));
  });

  it('takes at most two prompts from one session', async () => {
    const prompts = Array.from({ length: 20 }, (_, index) => prompt('one', index, 'edit-only', 'm-a'));
    const picked = await drawSample([...prompts, prompt('other', 0, 'edit-only', 'm-a')], 10, 'seed', accepted);
    expect(picked.filter((item) => item.session === 'one')).toHaveLength(2);
    expect(picked).toHaveLength(3);
  });

  it('draws past a rejected prompt and fills the sample from what is left', async () => {
    const prompts = Array.from({ length: 10 }, (_, index) => prompt(`s${String(index)}`, 0, 'edit-only', 'm-a'));
    const picked = await drawSample(prompts, 5, 'seed', (item) => Promise.resolve(Number(item.session.slice(1)) % 2 === 0));
    expect(picked.map((item) => Number(item.session.slice(1)) % 2)).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns what the frame holds when it is smaller than the size', async () => {
    const picked = await drawSample([prompt('a', 0, 'edit-only', 'm-a')], 5, 'seed', accepted);
    expect(picked).toHaveLength(1);
  });
});

describe('readTurns', () => {
  it('finds the same prompts as capture on the fixtures, so a store index names the same turn', () => {
    const text = readFileSync(join(FIXTURES, 'proj', readdirSync(join(FIXTURES, 'proj')).find((name) => name.endsWith('.jsonl')) ?? ''), 'utf8');
    const captured = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact });
    const turns = readTurns(text);
    expect(captured.prompts.length).toBeGreaterThan(0);
    expect(turns.map((turn) => turn.index)).toEqual(captured.prompts.map((item) => item.index));
    expect(turns.map((turn) => redact(turn.request).slice(0, 300))).toEqual(captured.prompts.map((item) => item.head));
  });

  it('skips sidechain, meta, tool-result, and angle-bracket user lines, and a repeated call', () => {
    const text = [
      user('first'),
      call('a', 'Bash', { command: 'ls' }),
      result('a', 'ok'),
      line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'side' } }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      user('<task-notification>x</task-notification>'),
      'not json',
      '',
      user('second'),
      call('a', 'Bash', { command: 'ls' }),
      said('closing'),
    ].join('\n');
    const turns = readTurns(text);
    expect(turns.map((turn) => turn.request)).toEqual(['first', 'second']);
    expect(turns[0]?.calls.map((item) => item.ok)).toEqual([true]);
    expect(turns[1]?.calls).toEqual([]);
    expect(turns[1]?.replies).toEqual(['closing']);
  });

  it('reads a failed result by flag and by exit line, and a block-list result', () => {
    const text = [
      user('go'),
      call('a', 'Bash', { command: 'x' }),
      result('a', 'boom', true),
      call('b', 'Bash', { command: 'y' }),
      result('b', 'Exit code 2\nboom'),
      call('c', 'Bash', { command: 'z' }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'fine' }] }] } }),
      call('d', 'Bash', { command: 'w' }),
    ].join('\n');
    const calls = readTurns(text)[0]?.calls ?? [];
    expect(calls.map((item) => item.ok)).toEqual([false, false, true, undefined]);
    expect(calls[2]?.result).toBe('fine');
  });
});

describe('viewOf', () => {
  const view = (lines: string[], index = 0): GoldView => viewOf(readTurns(lines.join('\n')), index, redact);

  it('shows the commit message and diff stat when the commit sits behind another command', () => {
    const shown = view([
      user('fix it'),
      call('a', 'Bash', { command: 'git add . && git -C "/w x" commit -m "ignored"' }),
      result('a', '[main abc1234] fix the parser\n 2 files changed, 10 insertions(+), 3 deletions(-)'),
    ]);
    expect(shown.commits).toEqual([{ subject: 'fix the parser', stat: '2 files changed, 10 insertions(+), 3 deletions(-)' }]);
  });

  it('falls back to the message on the command when the result names no commit', () => {
    const shown = view([
      user('fix it'),
      call('a', 'Bash', { command: `git commit -m 'one line'` }),
      result('a', 'done quietly'),
      call('b', 'Bash', { command: 'git commit -F - <<EOF\nheredoc subject\n\nbody\nEOF' }),
      result('b', ''),
      call('c', 'PowerShell', { command: "git commit -m @'\nhere string subject\n'@" }),
      result('c', ''),
      call('d', 'Bash', { command: 'git commit --no-edit' }),
      result('d', ''),
    ]);
    expect(shown.commits).toEqual([
      { subject: 'one line', stat: null },
      { subject: 'heredoc subject', stat: null },
      { subject: 'here string subject', stat: null },
      { subject: null, stat: null },
    ]);
  });

  it('does not read a failed commit, or a mention of one, as a commit', () => {
    const shown = view([
      user('fix it'),
      call('a', 'Bash', { command: 'git commit -m x' }),
      result('a', 'nothing to commit', true),
      call('b', 'Bash', { command: 'grep "git commit" notes.txt' }),
      result('b', 'git commit'),
    ]);
    expect(shown.commits).toEqual([]);
  });

  it('shows the final state from edit calls: one row a file, counted lines, code excerpt, no prose', () => {
    const shown = view([
      user('change it'),
      call('a', 'Edit', { file_path: '/w/src/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' }),
      result('a', 'ok'),
      call('b', 'Edit', { file_path: '/w/src/a.ts', old_string: 'x', new_string: 'latest edit' }),
      result('b', 'ok'),
      call('c', 'Write', { file_path: '/elsewhere/b.ts', content: 'l1\nl2' }),
      result('c', 'ok'),
      call('d', 'MultiEdit', { file_path: '/w/c.ts', edits: [{ old_string: 'a', new_string: 'b\nc' }] }),
      result('d', 'ok'),
      call('e', 'Write', { file_path: '/w/notes.md', content: 'Done. Everything passes.' }),
      result('e', 'ok'),
      call('f', 'Edit', { file_path: '/w/failed.ts', old_string: 'a', new_string: 'b' }),
      result('f', 'no match', true),
    ]);
    expect(shown.edits).toEqual([
      { file: 'src/a.ts', added: 4, removed: 3, calls: 2, excerpt: 'latest edit' },
      { file: '/elsewhere/b.ts', added: 2, removed: 0, calls: 1, excerpt: 'l1\nl2' },
      { file: 'c.ts', added: 2, removed: 1, calls: 1, excerpt: 'b\nc' },
      { file: 'notes.md', added: 1, removed: 0, calls: 1, excerpt: null },
    ]);
  });

  it('lists actions only when nothing was edited, because a shell call after an edit is the verify signal', () => {
    const edited = view([user('go'), call('a', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }), result('a', 'ok'), call('b', 'Bash', { command: 'npm test' }), result('b', 'ok')]);
    expect(edited.actions).toEqual([]);
    const looked = view([
      user('go'),
      call('a', 'Read', { file_path: '/w/a.ts' }),
      call('a2', 'Read', { file_path: '/w/a.ts' }),
      call('b', 'Bash', { command: 'git status' }),
      call('c', 'Grep', { pattern: 'needle' }),
      call('d', 'Agent', { prompt: 'look around' }),
      call('e', 'WebFetch', { url: 'https://example.org/x' }),
      call('f', 'WebSearch', { query: 'how' }),
      call('g', 'Glob', { pattern: '*.ts' }),
      call('h', 'ToolSearch', { query: 'x' }),
    ]);
    expect(looked.actions).toEqual(['Read a.ts x2', 'Bash git status', 'Grep needle', 'Agent', 'WebFetch https://example.org/x', 'WebSearch how', 'Glob *.ts', 'ToolSearch']);
  });

  it('counts the subagents, and says what the request before this one was', () => {
    const shown = view([user('earlier ask'), said('ok'), user('go on'), call('a', 'Agent', { prompt: 'x' }), call('b', 'Task', { prompt: 'y' })], 1);
    expect(shown.subagents).toBe(2);
    expect(shown.earlier).toBe('earlier ask');
    expect(view([user('only')]).earlier).toBeNull();
  });

  it('masks a secret in the request and the excerpt', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const shown = view([user(`use ${secret}`), call('a', 'Write', { file_path: '/w/a.ts', content: `const k = "${secret}"` }), result('a', 'ok')]);
    expect(JSON.stringify(shown)).not.toContain(secret);
    expect(shown.request).toContain('<secret>');
  });
});

const entry = (id: string, model: string, extra: Partial<GoldEntry> = {}): GoldEntry => ({
  id,
  session: `s-${id}`,
  index: 0,
  project: 'p',
  model,
  cls: 'edit-only',
  subagents: 0,
  signals: { verify: 'passed', stopped: null, commits: 0, redo: false },
  shown: 'shown',
  ...extra,
});

const viewFor = (request: string): GoldView => ({ request, earlier: null, commits: [], edits: [], actions: [], subagents: 0 });

describe('renderGold and parseGold', () => {
  const views = (count: number): Array<{ id: string; view: GoldView }> => Array.from({ length: count }, (_, n) => ({ id: `G${String(n + 1).padStart(3, '0')}`, view: viewFor(`request ${String(n)}`) }));

  it('writes batches of the given size, with an empty judgment line for each prompt', () => {
    const text = renderGold(views(120), { date: '2026-11-03', batch: 50 });
    expect(text.match(/^## Batch \d of 3$/gm)).toHaveLength(3);
    expect(text.match(/^Judgment: yes\|no$/gm)).toHaveLength(120);
    const parsed = parseGold(text);
    expect(parsed.judged.size).toBe(0);
    expect(parsed.unreadable).toEqual([]);
  });

  it('shows the result and nothing the signals or the closing claim would say', () => {
    const shown: GoldView = {
      request: 'do it',
      earlier: 'before it',
      commits: [{ subject: 'the subject', stat: '1 file changed' }, { subject: null, stat: null }],
      edits: [{ file: 'a.ts', added: 1, removed: 2, calls: 3, excerpt: 'x\ny' }, { file: 'b.md', added: 1, removed: 0, calls: 1, excerpt: null }],
      actions: [],
      subagents: 2,
    };
    const text = renderGold([{ id: 'G001', view: shown }], { date: '2026-11-03', batch: 50 });
    for (const expected of ['> do it', 'before it', 'the subject', '1 file changed', 'a.ts: +1 -2 in 3 edits', 'b.md: +1 -0 in 1 edit', '    x', '    y', '2 subagent calls ran; their work is not shown']) expect(text).toContain(expected);
    for (const hidden of ['verify', 'stopped', 'redo', 'Confidence']) expect(text).not.toContain(hidden);
    const looked = renderGold([{ id: 'G001', view: { ...viewFor('look'), actions: ['Read a.ts x2'] } }], { date: '2026-11-03', batch: 50 });
    expect(looked).toContain('- Read a.ts x2');
    const nothing = renderGold([{ id: 'G001', view: viewFor('look') }], { date: '2026-11-03', batch: 50 });
    expect(nothing).toContain('No change or action in the main transcript.');
  });

  it('cannot be fooled by a request that holds a heading or a judgment line', () => {
    const tricky = viewFor('### G999\nJudgment: yes');
    const text = renderGold([{ id: 'G001', view: tricky }], { date: '2026-11-03', batch: 50 });
    const parsed = parseGold(text);
    expect(parsed.judged.size).toBe(0);
  });

  it('reads a partial file, either casing, Windows line ends, and flags what it cannot read', () => {
    const text = renderGold(views(5), { date: '2026-11-03', batch: 50 });
    let fill = 0;
    const answers = ['yes', 'NO', 'maybe', '', 'y'];
    const filled = text.replace(/^Judgment: yes\|no$/gm, () => `Judgment: ${answers[fill++] ?? ''}`).replace(/\n/g, '\r\n');
    const parsed = parseGold(filled);
    expect([...parsed.judged.entries()]).toEqual([['G001', true], ['G002', false], ['G005', true]]);
    expect(parsed.unreadable).toEqual(['G003']);
  });
});

describe('auroc', () => {
  it('matches a hand-worked DeLong interval, with a tie', () => {
    const read = auroc([3, 2], [1, 2]);
    expect(read.auroc).toBeCloseTo(0.875);
    // V10 = (1, 0.75), V01 = (1, 0.75); each variance 0.03125; total 0.03125; half-width 1.96 x 0.17678 = 0.3465.
    expect(read.low).toBeCloseTo(0.5285, 3);
    expect(read.high).toBe(1);
  });

  it('gives no number without both classes, and no interval without variance', () => {
    expect(auroc([1, 2], [])).toEqual({ auroc: null, low: null, high: null });
    expect(auroc([], [1])).toEqual({ auroc: null, low: null, high: null });
    // Perfect separation: the variance estimate is zero, which is not certainty.
    expect(auroc([2, 3], [0, 1])).toEqual({ auroc: 1, low: null, high: null });
    // One row a side: nothing to estimate a variance from.
    expect(auroc([2], [1])).toEqual({ auroc: 1, low: null, high: null });
    // A signal with one value says nothing, and reads 0.5 with no interval.
    expect(auroc([1, 1], [1, 1])).toEqual({ auroc: 0.5, low: null, high: null });
  });

  it('reads below one half when the signal runs against the judgment', () => {
    expect(auroc([1, 1], [2, 2]).auroc).toBe(0);
  });
});

describe('scoreGold', () => {
  const entries: GoldEntry[] = [
    entry('G001', 'm-a', { signals: { verify: 'passed', stopped: null, commits: 1, redo: false } }),
    entry('G002', 'm-a', { signals: { verify: 'none', stopped: 'rejected', commits: 0, redo: true } }),
    entry('G003', 'm-a', { signals: { verify: 'failed', stopped: 'interrupt', commits: 0, redo: false } }),
    entry('G004', 'm-a', { signals: { verify: 'na', stopped: null, commits: 0, redo: false } }),
    entry('G005', 'm-b', { signals: { verify: 'passed', stopped: null, commits: 0, redo: false } }),
  ];
  const judged = new Map([['G001', true], ['G002', false], ['G003', false], ['G004', true], ['G005', true]]);

  it('reads each arm per model with its base rate, and leaves out rows the arm cannot read', () => {
    const score = scoreGold(entries, judged);
    const modelA = score.models.find((row) => row.model === 'm-a');
    expect(modelA?.judged).toBe(4);
    expect(modelA?.baseRate).toBe(0.5);
    const verify = modelA?.arms.find((row) => row.arm === 'verify');
    expect(verify?.covered).toBe(3); // G004 is `na`
    expect(verify?.baseRate).toBeCloseTo(1 / 3);
    expect(verify?.auroc).toBe(1);
    const stopped = modelA?.arms.find((row) => row.arm === 'stopped');
    expect(stopped?.covered).toBe(4);
    expect(stopped?.auroc).toBe(1);
    const redo = modelA?.arms.find((row) => row.arm === 'redo');
    expect(redo?.auroc).toBeCloseTo(0.75);
    const onlyYes = score.models.find((row) => row.model === 'm-b')?.arms.find((row) => row.arm === 'verify');
    expect(onlyYes?.auroc).toBeNull();
    expect(score.models.at(-1)?.model).toBe('all models');
    expect(score.models.at(-1)?.judged).toBe(5);
  });

  it('runs on no judgments, and says how many prompts each arm covers', () => {
    const score = scoreGold(entries, new Map());
    expect(score.models).toEqual([]);
    expect(score.coverage.find((row) => row.arm === 'verify')?.covered).toBe(4);
    expect(score.coverage.find((row) => row.arm === 'redo')?.covered).toBe(5);
    expect(score.total).toBe(5);
    const text = formatScore(score, []);
    expect(text).toContain('Judged 0 of 5');
    expect(text).toContain('verify');
    expect(text).not.toContain('AUROC');
  });

  it('prints rows with an interval, a dash for none, and the lines it could not read', () => {
    const text = formatScore(scoreGold(entries, judged), ['G009']);
    expect(text).toContain('Judged 5 of 5');
    expect(text).toContain('Could not read the judgment of G009');
    expect(text).toContain('m-a: 4 judged, base rate 50%');
    expect(text).toContain('all models: 5 judged');
    expect(text).toMatch(/redo\s+4\s+2\s+50%\s+0\.75\s+/);
    expect(text).toMatch(/verify\s+1\s+1\s+100%\s+-\s+-/);
  });
});

describe('writeGoldFiles', () => {
  it('refuses a gold file that is already there, keeps it as it was, and refuses a sidecar that is already there too', async () => {
    const staged = stage();
    const file = join(staged.root, 'outcome-gold-x.md');
    const arms = armsPath(file);
    writeFileSync(file, 'judged');
    // The existence check in `gold sample` came earlier: only `wx` on the gold file itself stops this write.
    await expect(writeGoldFiles(file, arms, '{}', 'blank')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(file, 'utf8')).toBe('judged');
    rmSync(file);
    await expect(writeGoldFiles(file, arms, '{}', 'blank')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(existsSync(file)).toBe(false);
    rmSync(arms);
    await writeGoldFiles(file, arms, '{"a":1}', 'blank');
    expect([readFileSync(file, 'utf8'), readFileSync(arms, 'utf8')]).toEqual(['blank', '{"a":1}']);
  });
});

describe('oars sessions gold', () => {
  // Under V15 a draw needs a term file (none excludes every session): an invented term that no fixture holds, unless the test is about its absence.
  const setup = (withTerms = true) => {
    const staged = stage();
    const termsFile = join(staged.root, 'exclusion-terms.txt');
    if (withTerms) writeFileSync(termsFile, 'unrelated-invented-term\n');
    const h = harness({ OARS_EXCLUSION_TERMS: termsFile });
    h.deps.sessions = staged.runtime;
    return { ...h, staged };
  };
  const work = (ask: string): string[] => [user(ask), call(`${ask}-a`, 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }), result(`${ask}-a`, 'ok'), said('All done. Confidence: high')];

  const populate = async (h: ReturnType<typeof setup>): Promise<void> => {
    addProject(h.staged, 'gold', 'keep-1', work('first ask'));
    addProject(h.staged, 'gold', 'keep-2', work('second ask'));
    addProject(h.staged, 'gold', 'named', [...work('third ask'), said('a note about Acme-Term here')]);
    // A session whose only mention is in its subagent transcript is out too.
    addProject(h.staged, 'gold', 'sub', work('fourth ask'));
    const agents = join(h.staged.projectsRoot, 'gold', 'sub', 'subagents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'agent-1.jsonl'), `${said('from acme-term, in lower case')}\n`);
    expect(await run(['sessions', 'deposit', '--allow', 'gold'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
  };

  it('samples without the excluded sessions, hides the signals in a sidecar, refuses to overwrite, and scores a partial file', async () => {
    const h = setup();
    await populate(h);
    const dir = join(h.staged.root, 'review');
    expect(await run(['sessions', 'gold', 'sample', '--size', '10', '--exclude-term', 'ACME-term', '--out-dir', dir, '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    const sampled = h.out.join('');
    expect(sampled).toContain('Excluded 2 sessions');
    const date = new Date(h.deps.now()).toISOString().slice(0, 10);
    const file = join(dir, `outcome-gold-${date}.md`);
    const text = readFileSync(file, 'utf8');
    expect(text.match(/^Judgment: yes\|no$/gm)).toHaveLength(2);
    expect(text.toLowerCase()).not.toContain('acme-term');
    expect(text).toContain('first ask');
    expect(text).toContain('second ask');
    expect(text).not.toContain('third ask');
    expect(text).not.toContain('fourth ask');
    expect(text).not.toContain('All done');
    expect(text).not.toContain('Confidence');
    expect(text).not.toContain('passed');
    const sidecar = readFileSync(join(dir, `outcome-gold-${date}.arms.json`), 'utf8');
    expect(sidecar).toContain('"verify"');
    expect(sidecar).toContain('"seed":"s"');

    h.err.length = 0;
    expect(await run(['sessions', 'gold', 'sample', '--out-dir', dir], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('already exists');
    expect(readFileSync(file, 'utf8')).toBe(text);

    // Moving the gold file alone, as that refusal advises, must not cost the sidecar's readings.
    const sidecarPath = join(dir, `outcome-gold-${date}.arms.json`);
    writeFileSync(sidecarPath, `${sidecar} `);
    rmSync(file);
    h.err.length = 0;
    expect(await run(['sessions', 'gold', 'sample', '--out-dir', dir], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain(`${sidecarPath} already exists`);
    expect(readFileSync(sidecarPath, 'utf8')).toBe(`${sidecar} `);
    expect(existsSync(file)).toBe(false);
    writeFileSync(sidecarPath, sidecar);
    writeFileSync(file, text);

    h.out.length = 0;
    expect(await run(['sessions', 'gold', 'score', file], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Judged 0 of 2');

    let first = true;
    writeFileSync(file, text.replace(/^Judgment: yes\|no$/gm, (blank) => {
      if (!first) return blank;
      first = false;
      return 'Judgment: yes';
    }));
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'gold', 'score', file], h.deps)).toBe(ExitCode.OK);
    const document: unknown = JSON.parse(h.out.join(''));
    expect(document).toMatchObject({ ok: true, judged: 1, total: 2 });
  });

  it('passes over a prompt whose transcript changed after the deposit, so its signals cannot describe another turn', async () => {
    const h = setup();
    await populate(h);
    addProject(h.staged, 'gold', 'keep-1', work('rewritten'));
    const dir = join(h.staged.root, 'stale');
    expect(await run(['sessions', 'gold', 'sample', '--out-dir', dir, '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Passed over 1 prompt whose transcript');
    const date = new Date(h.deps.now()).toISOString().slice(0, 10);
    const text = readFileSync(join(dir, `outcome-gold-${date}.md`), 'utf8');
    expect(text).not.toContain('first ask');
    expect(text).not.toContain('rewritten');
    expect(text).toContain('second ask');
  });

  it('lets one of two racing samples write, since the refusal is checked long before the write', async () => {
    const h = setup();
    await populate(h);
    const dir = join(h.staged.root, 'race');
    const codes = await Promise.all([1, 2].map(() => run(['sessions', 'gold', 'sample', '--out-dir', dir, '--seed', 's'], h.deps)));
    expect(codes.filter((code) => code === ExitCode.OK)).toHaveLength(1);
    expect(h.err.join('')).toContain('EEXIST');
  });

  it('refuses to sample when no term file is configured, since every session is then excluded (V15)', async () => {
    const h = setup(false);
    await populate(h);
    const dir = join(h.staged.root, 'no-terms');
    expect(await run(['sessions', 'gold', 'sample', '--size', '1', '--batch', '1', '--out-dir', dir, '--seed', 's'], h.deps)).toBe(ExitCode.INVALID);
    expect(h.err.join('')).toContain('term file');
    expect(existsSync(dir)).toBe(false);
  });

  it('says how many sampled prompts ran subagents, in the text and under --json, and uses the singular for one', async () => {
    const h = setup();
    addProject(h.staged, 'gold', 'keep-1', [...work('first ask'), call('agent-1', 'Agent', { prompt: 'x' }), result('agent-1', 'ok')]);
    addProject(h.staged, 'gold', 'keep-2', work('second ask'));
    expect(await run(['sessions', 'deposit', '--allow', 'gold'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
    expect(await run(['sessions', 'gold', 'sample', '--size', '10', '--out-dir', join(h.staged.root, 'text'), '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('');
    expect(text).toContain('Wrote 2 prompts, ');
    expect(text).toContain('1 sampled prompt ran subagents, whose work is not read.');
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'gold', 'sample', '--size', '10', '--out-dir', join(h.staged.root, 'json'), '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: true, prompts: 2, subagentPrompts: 1 });
  });

  it('says one prompt and one session in the singular', async () => {
    const h = setup();
    addProject(h.staged, 'gold', 'keep-1', work('first ask'));
    addProject(h.staged, 'gold', 'named', [...work('third ask'), said('a note about Acme-Term here')]);
    expect(await run(['sessions', 'deposit', '--allow', 'gold'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
    expect(await run(['sessions', 'gold', 'sample', '--exclude-term', 'acme-term', '--out-dir', join(h.staged.root, 'one'), '--seed', 's'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Wrote 1 prompt, ');
    expect(h.out.join('')).toContain('Excluded 1 session the draw reached');
  });

  it('takes the default folder beside the projects root, and reports the excluded count when no extra term is named', async () => {
    const h = setup();
    await populate(h);
    expect(await run(['sessions', 'gold', 'sample', '--size', '1', '--batch', '1'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Excluded 0 sessions');
    expect(readdirSync(join(h.staged.root, 'session-commons', 'review')).filter((name) => name.endsWith('.md'))).toHaveLength(1);
  });

  it('fails plainly on a missing gold file, a missing sidecar, and a run with no store', async () => {
    const h = setup();
    const missing = join(h.staged.root, 'outcome-gold-x.md');
    expect(await run(['sessions', 'gold', 'score', missing], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('Cannot read the gold file');
    h.err.length = 0;
    writeFileSync(missing, '# empty\n');
    expect(await run(['sessions', 'gold', 'score', missing], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('Cannot read the arms file');
    h.deps.sessions = undefined;
    expect(await run(['sessions', 'gold', 'sample'], h.deps)).toBe(ExitCode.UNEXPECTED);
  });
});
