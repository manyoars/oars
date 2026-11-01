import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { cleanup, stage } from './test-support.js';

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
