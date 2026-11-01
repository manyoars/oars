import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addProject, cleanup, FIXTURES, stage } from './test-support.js';

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
    expect(err.join('')).toContain('1 checks failed');
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

  it('recall needs a query, and --by takes only class or model', async () => {
    const { deps, err } = setup();
    expect(await run(['sessions', 'recall'], deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'books', '--by', 'colour'], deps)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('class or model');
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
});
