import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { harness } from '../test-support.js';
import { session, store, tool } from './pool-fixture.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { familyOf, recentSessions, resolveSession, reviewReceiptOf, reviewReceiptText, scrub, VERIFICATION_FAMILIES } from './review-receipt.js';
import { HARNESS_ERROR_CLASSES, type ToolObservation } from './schema.js';
import type * as StoreModule from './store.js';
import type { Store } from './store.js';

const held = vi.hoisted((): { store: Store | undefined } => ({ store: undefined }));
vi.mock('./store.js', async (original) => ({ ...(await original<typeof StoreModule>()), loadStore: () => Promise.resolve(held.store) }));

const VERSION = '9.9.9';
const HOME = 'C:\\Users\\alice';

/** A shell call of the given commands, each as the plain words capture stores in `segments[].run` (no flags, no paths). */
const call = (id: string, n: number, runs: string[], over: Partial<ToolObservation> = {}): ToolObservation =>
  tool(id, n, 'Bash', { templates: runs, segments: runs.map((word) => ({ run: word, read: true })), ...over });

const redact = makeRedactor();
const rawLine = (type: string, content: unknown): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type, model: 'm', content } });
/** The calls capture stores for raw Bash lines, so a family is proven on what the real writer produces and not on a hand-built shape. */
const captured = (...commands: string[]): { store: Store; id: string } => {
  const text = [rawLine('user', 'go'), ...commands.map((command, index) => rawLine('assistant', [{ type: 'tool_use', id: `c${String(index)}`, name: 'Bash', input: { command } }]))].join('\n');
  const held = captureSession({ text, session: 'cap', project: 'p', rev: 1, at: '', bytes: 0, redact, harness: 'claude-code' });
  return { store: store({ sessions: [held.session], tools: held.tools }), id: 'cap' };
};
const listed = (...commands: string[]): string[] => {
  const { store: s, id } = captured(...commands);
  const found = resolveSession(s, id);
  return found === undefined ? [] : reviewReceiptOf(s, found, HOME).rows.map((row) => row.command);
};

/** One Claude Code session: a test that passed, a build that failed with exit 1, a hidden type check, a call with no result, a signal, and two other commands. */
const fixture = (): Store =>
  store({
    sessions: [
      session('s1', { tsFirst: '2026-11-10T09:00:00.000Z', models: { 'claude-opus-x': 5, 'claude-haiku-x': 1 } }),
      session('s2', { tsFirst: '2026-11-12T09:00:00.000Z' }),
      session('s3', { harness: 'codex', tsFirst: '2026-11-11T09:00:00.000Z' }),
    ],
    tools: [
      call('s1', 0, ['git status']),
      call('s1', 1, ['npx vitest run']),
      call('s1', 2, ['npm run build'], { status: 'error', errorCode: '1' }),
      call('s1', 3, ['tsc', 'echo'], { segments: [{ run: 'tsc', read: false }, { run: 'echo', read: true }] }),
      call('s1', 4, ['eslint'], { status: 'none' }),
      call('s1', 5, ['ls']),
      call('s1', 6, ['pytest'], { status: 'error', errorCode: 'signal' }),
      call('s2', 0, ['ls']),
      call('s3', 0, ['cargo test'], { status: 'ok' }),
    ],
  });

describe('verification families', () => {
  // Each is the `run` capture stores: the program and its plain words, no flags.
  const cases: Array<[string, string]> = [
    ['npm test', 'test'],
    ['npm run test:unit', 'test'],
    ['npx vitest run', 'test'],
    ['jest', 'test'],
    ['python pytest', 'test'],
    ['go test', 'test'],
    ['cargo test', 'test'],
    ['mvn core verify', 'test'],
    ['gradle test', 'test'],
    ['just check', 'test'],
    ['npm run build', 'build'],
    ['cargo build', 'build'],
    ['eslint', 'lint'],
    ['ruff check', 'lint'],
    ['npm run lint', 'lint'],
    ['tsc', 'type check'],
    ['npx mypy', 'type check'],
    ['prettier src', 'format check'],
    ['cargo fmt', 'format check'],
  ];
  it.each(cases)('lists %s as a %s command', (command, family) => {
    expect(familyOf(command)).toBe(family);
  });
  it('has a case above for every family and leaves other commands out', () => {
    expect(new Set(cases.map((entry) => entry[1]))).toEqual(new Set(VERIFICATION_FAMILIES.map((entry) => entry.family)));
    expect(familyOf('prettier src', false)).toBeUndefined();
    expect(familyOf('ruff format .')).toBe('format check');
    for (const other of ['git status', 'ls', 'npm install', 'echo test', 'cat testing.txt']) expect(familyOf(other)).toBeUndefined();
  });
});

describe('scrub', () => {
  it('replaces the home directory and any absolute path with <path>', () => {
    expect(scrub(`pytest ${HOME}\\work\\app /etc/passwd ~/x C:\\other\\y`, HOME)).toBe('pytest <path> <path> <path> <path>');
    expect(scrub('pytest C:/Users/alice/work', HOME)).toBe('pytest <path>');
  });
  it('drops environment assignments and everything after a secret flag', () => {
    expect(scrub('API_KEY=abc123 FOO=1 npm test', HOME)).toBe('npm test');
    expect(scrub('npm test --token sk-live-9 --coverage', HOME)).toBe('npm test');
    expect(scrub('deploy --password=hunter2 now', HOME)).toBe('deploy');
    expect(scrub('mysql -p hunter2 run', HOME)).toBe('mysql');
    expect(scrub('mvn -pl core test', HOME)).toBe('mvn -pl core test');
    expect(scrub('npm test KEY=sk-abc', HOME)).toBe('npm test');
  });
  it('cuts a multi-line command to its first line with an ellipsis, and a long one to a length', () => {
    expect(scrub('npm test\necho SECRET-SECOND-LINE', HOME)).toBe('npm test…');
    expect(scrub(`npm ${'x'.repeat(200)}`, HOME)).toHaveLength(121);
  });
  it('cuts only a path that starts a word, so a relative path and a URL keep their slashes', () => {
    expect(scrub('vitest src/a.ts', HOME)).toBe('vitest src/a.ts');
    expect(scrub('curl https://x.example/y', HOME)).toBe('curl https://x.example/y');
    expect(scrub('vitest /abs/a.ts ./rel', HOME)).toBe('vitest <path> ./rel');
  });
  it('leaves a one-character home alone', () => {
    expect(scrub('npm test', '/')).toBe('npm test');
  });
});

describe('reviewReceiptOf', () => {
  const receipt = (id: string): ReturnType<typeof reviewReceiptOf> => {
    const s = fixture();
    const found = resolveSession(s, id);
    if (found === undefined) throw new Error('no session');
    return reviewReceiptOf(s, found, HOME);
  };

  it('lists verification commands in order with the observed result and counts the rest', () => {
    const r = receipt('s1');
    expect(r.rows).toEqual([
      { order: 2, family: 'test', command: 'npx vitest run', result: 'exit 0' },
      { order: 3, family: 'build', command: 'npm run build', result: 'exit 1' },
      { order: 4, family: 'type check', command: 'tsc', result: 'not recorded' },
      { order: 5, family: 'lint', command: 'eslint', result: 'not recorded' },
      { order: 7, family: 'test', command: 'pytest', result: 'failed' },
    ]);
    expect(r).toMatchObject({ date: '2026-11-10', harness: 'claude-code', model: 'claude-opus-x', calls: 7, other: 3 });
  });

  it('prints a Codex call as not recorded, never as passed', () => {
    expect(receipt('s3').rows).toEqual([{ order: 1, family: 'test', command: 'cargo test', result: 'not recorded' }]);
  });

  it('reads a call with no segments by whether it holds one command', () => {
    const one = call('s1', 0, ['npm test']);
    delete one.segments;
    const two = call('s1', 1, ['npm test', 'npm run build']);
    delete two.segments;
    const r = reviewReceiptOf(store({ sessions: [session('s1')], tools: [one, two] }), session('s1'), HOME);
    expect(r.rows.map((row) => row.result)).toEqual(['exit 0', 'not recorded', 'not recorded']);
  });

  it('prints the table, the totals, and the footer', () => {
    expect(reviewReceiptText(receipt('s1'), VERSION)).toBe(
      [
        '# Review receipt: verification commands one session ran',
        '',
        '- Session date: 2026-11-10',
        '- Harness: claude-code',
        '- Model: claude-opus-x',
        "- Scope: one session's own tool calls (7 in all); commands run in its subagents are not included.",
        '',
        '| Command | Result | Call # |',
        '| --- | --- | --- |',
        '| `npx vitest run` | exit 0 | 2 |',
        '| `npm run build` | exit 1 | 3 |',
        '| `tsc` | not recorded | 4 |',
        '| `eslint` | not recorded | 5 |',
        '| `pytest` | failed | 7 |',
        '',
        '5 verification commands (1 exit 0, 1 exit 1, 1 failed, 2 not recorded); 3 other commands not shown.',
        '',
        '---',
        "What this is: commands the session ran and the results it observed on the author's machine. It is not proof the change is correct, and it maps to no pull request. Made locally by oars: `oars sessions receipt`  |  oars 9.9.9",
      ].join('\n'),
    );
  });

  it('states an empty session in one line and a lone command in the singular', () => {
    const text = reviewReceiptText(receipt('s2'), VERSION);
    expect(text).toContain('No verification commands recorded.\n\n0 verification commands; 1 other command not shown.');
    expect(text).not.toContain('| Command |');
    const bare = reviewReceiptText({ session: 'x', date: null, harness: 'cursor', model: null, calls: 1, rows: [{ order: 1, family: 'test', command: 'a|b `c`', result: 'exit 0' }], other: 0 }, VERSION);
    expect(bare).toContain('- Session date: not recorded\n- Harness: cursor\n- Model: not recorded');
    expect(bare).toContain("| `a\\|b 'c'` | exit 0 | 1 |");
    expect(bare).toContain('1 verification command (1 exit 0); 0 other commands not shown.');
  });

  it('prints no home path, secret, or second line from a command', () => {
    const risky = call('p', 0, [`API_KEY=sk-live-123 pytest ${HOME}\\secret-repo\\tests --token sk-live-456`, 'npm test\necho PRIVATE-SECOND-LINE', `vitest ${HOME}/work/app`]);
    const text = reviewReceiptText(reviewReceiptOf(store({ sessions: [session('p')], tools: [risky] }), session('p'), HOME), VERSION);
    for (const leaked of ['alice', 'secret-repo', 'sk-live', 'API_KEY', 'PRIVATE-SECOND-LINE']) expect(text).not.toContain(leaked);
    expect(text).toContain('| `pytest <path>` |');
    expect(text).toContain('| `npm test…` |');
    expect(text).toContain('| `vitest <path>` |');
  });
});

describe('what capture really stores', () => {
  it('lists each family from raw Bash lines through captureSession', () => {
    expect(listed('npm run build')).toEqual(['npm run build']);
    expect(listed('npx vitest run src/a.test.ts')).toEqual(['npx vitest run']);
    expect(listed('just check')).toEqual(['just check']);
    expect(listed('python -m pytest -k foo')).toEqual(['python pytest foo']);
    expect(listed('cargo fmt -- --check')).toEqual(['cargo fmt --check']);
    expect(listed('npm run lint')).toEqual(['npm run lint']);
    expect(listed('tsc --noEmit')).toEqual(['tsc']);
    expect(listed('npm run test:unit', 'go test ./...', 'cargo test --all', 'pnpm exec vitest', 'uv run pytest', 'ruff check .', 'prettier --check src', 'ruff format --check .')).toEqual([
      'npm run test:unit',
      'go test',
      'cargo test',
      'pnpm exec vitest',
      'uv run pytest',
      'ruff check .',
      'prettier src --check',
      'ruff format . --check',
    ]);
  });

  it('does not list a formatter that rewrites files, or a command outside the list', () => {
    expect(listed('cargo fmt', 'prettier --write src', 'ruff format .', 'git status', 'npm install')).toEqual([]);
  });

  it('counts commands, not calls, for the unlisted: a mixed call adds one for its other command', () => {
    const { store: s, id } = captured('npm test && git push', 'git status && ls', 'ls');
    const found = resolveSession(s, id);
    expect(found === undefined ? null : reviewReceiptOf(s, found, HOME)).toMatchObject({ rows: [{ command: 'npm test' }], other: 4 });
  });
});

describe('a call the harness refused', () => {
  it.each(HARNESS_ERROR_CLASSES)('prints %s as not recorded, never failed', (code) => {
    const s = store({ sessions: [session('h')], tools: [call('h', 0, ['npm test'], { status: 'error', errorCode: code })] });
    expect(reviewReceiptOf(s, session('h'), HOME).rows).toEqual([{ order: 1, family: 'test', command: 'npm test', result: 'not recorded' }]);
  });
});

describe('a sidechain call', () => {
  it('is left out of the table, the count of calls, and the order numbers', () => {
    const s = store({ sessions: [session('c')], tools: [call('c', 0, ['npm run lint'], { side: true }), call('c', 1, ['npm test']), call('c', 2, ['npm run build'])] });
    const r = reviewReceiptOf(s, session('c'), HOME);
    expect(r.rows.map((row) => [row.command, row.order])).toEqual([['npm test', 1], ['npm run build', 2]]);
    expect(r.calls).toBe(2);
  });
});

describe('session references', () => {
  it('resolves an exact id or a unique prefix, and skips a superseded session', () => {
    const s = store({ sessions: [session('abc-1'), session('abc-2'), session('xyz-1'), session('old', { supersededBy: 'xyz-1' })] });
    expect(resolveSession(s, 'xyz')?.session).toBe('xyz-1');
    expect(resolveSession(s, 'abc-2')?.session).toBe('abc-2');
    expect(resolveSession(s, 'abc')).toBeUndefined();
    expect(resolveSession(s, 'old')).toBeUndefined();
    expect(resolveSession(s, '')).toBeUndefined();
  });
  it('orders sessions of one day by their time and prints the date only', () => {
    const day = store({ sessions: [session('late', { tsFirst: '2026-11-05T18:00:00.000Z' }), session('early', { tsFirst: '2026-11-05T08:00:00.000Z' }), session('aa', { tsFirst: '2026-11-04T23:00:00.000Z' })] });
    expect(recentSessions(day)).toEqual([
      { session: 'late', date: '2026-11-05' },
      { session: 'early', date: '2026-11-05' },
      { session: 'aa', date: '2026-11-04' },
    ]);
  });
  it('lists the five most recent sessions by date, newest first', () => {
    const many = store({ sessions: ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => session(id, { tsFirst: `2026-11-0${String(index + 1)}T00:00:00.000Z` })).concat(session('z')) });
    expect(recentSessions(many)).toEqual([
      { session: 'f', date: '2026-11-06' },
      { session: 'e', date: '2026-11-05' },
      { session: 'd', date: '2026-11-04' },
      { session: 'c', date: '2026-11-03' },
      { session: 'b', date: '2026-11-02' },
    ]);
    expect(recentSessions(store({ sessions: [session('z')] }))).toEqual([{ session: 'z', date: 'no date' }]);
  });
});

describe('oars sessions receipt through run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oars-review-receipt-'));
    held.store = fixture();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const wired = (): ReturnType<typeof harness> => {
    const h = harness({ APPDATA: dir });
    h.deps.version = VERSION;
    h.deps.sessions = { storeDir: join(dir, 'store'), projectsRoot: join(dir, 'projects'), stdin: process.stdin, stdout: { write: () => true } };
    return h;
  };

  it('prints the receipt to stdout and exits 0', async () => {
    const h = wired();
    expect(await run(['sessions', 'receipt', 's1'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('| `npm run build` | exit 1 | 3 |');
  });

  it('writes the file with --out and prints one line', async () => {
    const h = wired();
    const file = join(dir, 'out', 'receipt.md');
    expect(await run(['sessions', 'receipt', 's1', '--out', file], h.deps)).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('# Review receipt');
    expect(h.out.join('')).toBe(`Wrote ${file}\n`);
  });

  it('prints usage and the most recent ids with no id', async () => {
    const h = wired();
    expect(await run(['sessions', 'receipt'], h.deps)).toBe(0);
    const out = h.out.join('');
    expect(out).toContain('Usage: oars sessions receipt <session-id>');
    expect(out).toContain('  s2  2026-11-12');
  });

  it('says so when the store has no session', async () => {
    held.store = store({});
    const h = wired();
    expect(await run(['sessions', 'receipt'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('No sessions in the local store yet.');
  });

  it('exits non-zero with one line for an unknown id', async () => {
    const h = wired();
    expect(await run(['sessions', 'receipt', 'nope'], h.deps)).not.toBe(0);
    expect(h.err.join('').trim().split('\n')).toHaveLength(1);
    expect(h.err.join('')).toContain('No session nope');
  });

  it('fails when the run has no session store', async () => {
    const h = wired();
    h.deps.sessions = undefined;
    expect(await run(['sessions', 'receipt', 's1'], h.deps)).not.toBe(0);
  });

  it('starts no sender after the command, so nothing leaves the machine', async () => {
    const h = wired();
    const catchUp = vi.fn(() => Promise.resolve());
    h.deps.catchUp = catchUp;
    expect(await run(['sessions', 'receipt', 's1'], h.deps)).toBe(0);
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('carries the receipt under --json', async () => {
    const h = wired();
    expect(await run(['--json', 'sessions', 'receipt', 's1'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: true, receipt: { session: 's1', calls: 7 } });
  });
});
