import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProject, cleanup, composers, FIXTURES, folders, stage, stageCursor, stageRawCursor } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const setup = () => {
  const staged = stage();
  const h = harness();
  h.deps.sessions = staged.runtime;
  return { ...h, staged };
};

const json = (out: string[]): unknown => JSON.parse(out.join(''));
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

describe('oars sessions with a Cursor store', () => {
  const withCursor = async () => {
    const h = setup();
    const { repo, plain } = folders(h.staged.root);
    const user = await stageCursor(h.staged.root, composers(repo, plain));
    h.deps.sessions = { ...h.staged.runtime, cursorRoot: user };
    return { ...h, user };
  };

  it('prints the Cursor line once when the store was read, and nothing about Cursor when it was not allowed', async () => {
    const { deps, out } = await withCursor();
    expect(await run(['sessions', 'deposit', '--allow', 'cursor'], deps)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text.match(/Read 3 Cursor sessions\./g)).toHaveLength(1);
    expect(text).not.toContain('Cursor store not read');
    expect(text).not.toContain('No project folder matched');
    out.length = 0;
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).not.toContain('Cursor');
  });

  it('warns once, naming the file, when the Cursor store cannot be read', async () => {
    const h = setup();
    const user = join(h.staged.root, 'Cursor', 'User');
    mkdirSync(join(user, 'globalStorage'), { recursive: true });
    writeFileSync(join(user, 'globalStorage', 'state.vscdb'), 'not a database');
    h.deps.sessions = { ...h.staged.runtime, cursorRoot: user };
    expect(await run(['sessions', 'deposit', '--allow', 'cursor'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('');
    expect(text.match(/Cursor store not read: .*state\.vscdb/g)).toHaveLength(1);
    expect(text).not.toContain('Cursor sessions.');
  });

  it('says how many Cursor sessions were skipped for an id that is not a safe file name', async () => {
    const h = setup();
    const doc = (composerId: string) => ({ composerId, createdAt: 1, conversation: [{ type: 1, text: 'hi' }] });
    const user = await stageRawCursor(h.staged.root, [{ id: 'good', document: doc('good') }, { id: 'bad', document: doc('../../escaped') }], []);
    h.deps.sessions = { ...h.staged.runtime, cursorRoot: user };
    expect(await run(['sessions', 'deposit', '--allow', 'cursor'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('');
    expect(text.match(/Skipped 1 Cursor sessions whose id is not a safe file name\./g)).toHaveLength(1);
    expect(text).toContain('Read 1 Cursor sessions.');
  });

  it('books --by harness keys the rows by harness', async () => {
    const { deps, out } = await withCursor();
    await run(['sessions', 'deposit', '--allow', 'cursor', '--allow', 'proj'], deps);
    out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'harness', '--json'], deps)).toBe(ExitCode.OK);
    const document = json(out);
    expect(field(document, 'by')).toBe('harness');
    const rows = field(document, 'rows');
    const keys = Array.isArray(rows) ? rows.map((row): unknown => field(row, 'key')) : [];
    expect(keys).toContain('cursor');
    expect(keys).not.toContain('edit-verify');
  });
});

describe('oars sessions', () => {
  it('deposit refuses without --allow (exit 2) and reads nothing', async () => {
    const { deps, err } = setup();
    expect(await run(['sessions', 'deposit'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--allow');
  });

  it('runs deposit, books, recall, measure, and verify end to end, as text and as JSON', async () => {
    const { deps, out } = setup();
    expect(await run(['sessions', 'deposit', '--allow', 'proj', '--redact-domain', 'corp.example'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Deposited 4 sessions');
    out.length = 0;
    expect(await run(['sessions', 'books'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('edit-verify');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'books', '--by', 'model', '--since', '3650'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'by')).toBe('model');
    out.length = 0;
    expect(await run(['sessions', 'recall', '--error', 'unexpected EOF while looking for matching quote'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('2 sessions');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'recall', '--class', 'edit-verify', '--path', 'main.ts', '--since', '3650'], deps)).toBe(ExitCode.OK);
    expect(Array.isArray(field(json(out), 'matches'))).toBe(true);
    out.length = 0;
    expect(await run(['sessions', 'measure', '--last', '2'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('recurring errors per 100 sessions');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'sessions')).toBe(4);
    out.length = 0;
    expect(await run(['sessions', 'verify', '--session', 'tldr'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('1 skeletons checked');
    expect(await run(['sessions', 'verify', '--strict'], deps)).toBe(ExitCode.OK);
  });

  it('read serves every family from the deposited store, each row stating clusters: 1, with no floor on one session', async () => {
    const { deps, out, staged } = setup();
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], deps)).toBe(ExitCode.OK);
    out.length = 0;
    expect(await run(['sessions', 'read'], deps)).toBe(ExitCode.OK);
    const text = out.join('');
    const rows = text.split('\n').filter((line) => line.startsWith('  n='));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.includes('clusters: 1'))).toBe(true);
    expect(text).toContain('fit (');
    expect(text).toContain('cost (');
    expect(text).not.toContain(staged.storeDir);
    out.length = 0;
    expect(await run(['--json', 'sessions', 'read', '--family', 'cost'], deps)).toBe(ExitCode.OK);
    const document = json(out);
    const reads = field(document, 'reads');
    expect(Array.isArray(reads) && reads.length > 0 && reads.every((read: { family: string; clusters: number; order: number }) => read.family === 'cost' && read.clusters === 1 && read.order === 1)).toBe(true);
    expect(typeof field(document, 'pool')).toBe('string');
    expect(field(document, 'newerCaptures')).toBe(0);
    out.length = 0;
    expect(await run(['sessions', 'read', '--family', 'cost', '--slice', 'class=no-such-class'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('No reads match.');
  });

  it('read leaves the capture log as it was, and a second read cites the same reads', async () => {
    const { deps, out, staged } = setup();
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], deps)).toBe(ExitCode.OK);
    const log = readFileSync(join(staged.storeDir, 'observations.jsonl'));
    out.length = 0;
    expect(await run(['--json', 'sessions', 'read'], deps)).toBe(ExitCode.OK);
    const first = field(json(out), 'reads');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'read'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'reads')).toEqual(first);
    expect(readFileSync(join(staged.storeDir, 'observations.jsonl')).equals(log)).toBe(true);
  });

  it('read refuses an unknown family and a malformed slice (exit 2), and logs its own step, not a recall', async () => {
    const { deps, out, err } = setup();
    expect(await run(['sessions', 'read', '--family', 'nope'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('next-step');
    err.length = 0;
    expect(await run(['sessions', 'read', '--slice', 'model'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('<axis>=<value>');
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], deps)).toBe(ExitCode.OK);
    expect(await run(['sessions', 'read'], deps)).toBe(ExitCode.OK);
    out.length = 0;
    expect(await run(['--json', 'sessions', 'measure', '--last', '2'], deps)).toBe(ExitCode.OK);
    expect(field(field(json(out), 'steps'), 'recall')).toMatchObject({ queries: 0 });
  });

  it('verify --strict exits 4 after printing when a skeleton has an exception, and plain verify still exits 0', async () => {
    const { deps, out, err, staged } = setup();
    const corrupted = readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => line.replace('"tool_use_id": "t1"', '"tool_use_id": "nope"').replace('"tool_use_id":"t1"', '"tool_use_id":"nope"'));
    addProject(staged, 'bad', 'bad', corrupted);
    expect(await run(['sessions', 'deposit', '--allow', 'bad'], deps)).toBe(ExitCode.OK);
    out.length = 0;
    expect(await run(['sessions', 'verify'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('FAIL');
    out.length = 0;
    expect(await run(['sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    expect(out.join('')).toContain('FAIL');
    expect(err.join('')).toContain('1 check failed');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    const document: unknown = JSON.parse(out.join(''));
    expect(field(document, 'ok')).toBe(false);
    expect(field(document, 'step')).toBe('verify');
    expect(Array.isArray(field(document, 'invariants'))).toBe(true);
    expect(field(document, 'sessions')).toBe(1);
    expect(field(document, 'unreadable')).toBe(0);
  });

  it('verify reports a torn skeleton file and strict fails on it', async () => {
    const { deps, out, staged } = setup();
    await run(['sessions', 'deposit', '--allow', 'proj'], deps);
    writeFileSync(join(staged.storeDir, 'skeletons', 'torn.json'), '{"lines": [');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'unreadable')).toBe(1);
    out.length = 0;
    expect(await run(['sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    expect(out.join('')).toContain('1 unreadable skeleton files');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    const strict: unknown = JSON.parse(out.join(''));
    expect(field(strict, 'unreadable')).toBe(1);
    expect(field(strict, 'sessions')).toBe(4);
  });

  it('verify --strict exits 4 and names merkle: counts do not bind when a skeleton leaf count disagrees with its session', async () => {
    const { deps, out, err, staged } = setup();
    await run(['sessions', 'deposit', '--allow', 'proj'], deps);
    const file = join(staged.storeDir, 'skeletons', 'tldr.json');
    const skeleton: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const leaves = field(skeleton, 'leaves');
    if (typeof leaves !== 'number') throw new Error('no leaves');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`"leaves":${String(leaves)}`, `"leaves":${String(leaves + 1)}`));
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    out.length = 0;
    expect(await run(['sessions', 'verify', '--strict'], deps)).toBe(ExitCode.INVALID);
    expect(out.join('')).toContain('FAIL  tldr: counts do not bind');
    expect(err.join('')).toContain('1 check failed');
  });

  it('verify --session leaves a torn skeleton of another session out of unreadable and failed', async () => {
    const { deps, out, staged } = setup();
    await run(['sessions', 'deposit', '--allow', 'proj'], deps);
    writeFileSync(join(staged.storeDir, 'skeletons', 'torn.json'), '{"lines": [');
    out.length = 0;
    expect(await run(['--json', 'sessions', 'verify', '--session', 'tldr', '--strict'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'unreadable')).toBe(0);
  });

  it('recall masks a query with the domains the deposit masked', async () => {
    const { deps, out, staged } = setup();
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', uuid: 'b', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Exit code 1\ncannot reach build.corp.example' }] } }),
    ];
    addProject(staged, 'dom', 'dom', lines);
    await run(['sessions', 'deposit', '--allow', 'dom', '--redact-domain', 'corp.example'], deps);
    out.length = 0;
    expect(await run(['--json', 'sessions', 'recall', '--error', 'Bash | cannot reach build.corp.example'], deps)).toBe(ExitCode.OK);
    expect(field(json(out), 'matches')).toHaveLength(1);
  });

  it('recall needs a query, and --by takes only class, model, or harness', async () => {
    const { deps, err } = setup();
    expect(await run(['sessions', 'recall'], deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'books', '--by', 'colour'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('class, model, or harness');
  });

  it('serves MCP over the runtime stdio with recall --mcp', async () => {
    const { deps, staged } = setup();
    await run(['sessions', 'deposit', '--allow', 'proj'], deps);
    staged.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    staged.stdin.end();
    expect(await run(['sessions', 'recall', '--mcp'], deps)).toBe(ExitCode.OK);
    expect(staged.written.join('')).toContain('"result":{}');
  });

  it('fails clearly when the run has no session store', async () => {
    const { deps } = setup();
    deps.sessions = undefined;
    expect(await run(['sessions', 'books'], deps)).toBe(ExitCode.UNEXPECTED);
  });

  it('deposit reads the folders an --allow-file names, with a glob, in one command', async () => {
    const { deps, out, staged } = setup();
    addProject(staged, 'other', 'x', ['{"type":"user"}']);
    const list = join(staged.root, 'allow.txt');
    writeFileSync(list, '# my folders\nproj\n');
    expect(await run(['sessions', 'deposit', '--allow-file', list], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Deposited 4 sessions');
    expect(out.join('')).toContain('Read 1 folders; skipped 1');
    out.length = 0;
    writeFileSync(list, 'pro*\noth?r\n');
    expect(await run(['sessions', 'deposit', '--allow-file', list], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('Read 2 folders');
  });

  it('deposit refuses an unreadable --allow-file (exit 2) and an empty one', async () => {
    const { deps, err, staged } = setup();
    expect(await run(['sessions', 'deposit', '--allow-file', join(staged.root, 'nope.txt')], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--allow-file');
    const empty = join(staged.root, 'empty.txt');
    writeFileSync(empty, '# nothing\n');
    expect(await run(['sessions', 'deposit', '--allow-file', empty], deps)).toBe(ExitCode.USAGE);
  });
});
