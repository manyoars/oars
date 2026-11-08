import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { EMPTY_RECALL, emptyBooks } from './empty-state.js';
import { MISS_TEXT } from './recall-render.js';
import { cleanup, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

/** A machine with no coding-agent history: an empty projects folder, and a Cursor location with nothing in it. */
const bare = () => {
  const staged = stage();
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
  const cursor = join(staged.root, 'cursor-none');
  const h = harness();
  h.deps.sessions = { ...staged.runtime, sourceRoots: { cursor } };
  return { ...h, staged, cursor };
};

describe('empty states', () => {
  it('deposit that finds nothing prints the folders it looked in and the count found in each', async () => {
    const { deps, out, staged, cursor } = bare();
    expect(await run(['sessions', 'deposit'], deps)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text).toContain('Found no sessions. Looked in:');
    expect(text).toContain(`  Claude Code: ${staged.projectsRoot} (0 project folders read, 0 not on the allowlist)`);
    expect(text).toContain(`  Cursor: ${cursor} (0 sessions read)`);
    expect(text).toContain('oars sessions try');
  });

  it('deposit that finds sessions does not print the empty-state lines, and a rerun that finds them unchanged does not either', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('Found no sessions');
    h.out.length = 0;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('Found no sessions');
  });

  it('recall on an empty store says it is empty and names the command that fills it', async () => {
    const { deps, out } = bare();
    expect(await run(['sessions', 'recall', '--error', 'unexpected EOF'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toBe(`${EMPTY_RECALL}\n`);
    expect(EMPTY_RECALL).toContain('oars sessions deposit');
    out.length = 0;
    expect(await run(['sessions', 'recall', '--text', 'anything'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toBe(`${EMPTY_RECALL}\n`);
  });

  it('recall on a store with sessions in it keeps its own miss text', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    await run(['sessions', 'deposit'], h.deps);
    h.out.length = 0;
    expect(await run(['sessions', 'recall', '--error', 'a message no fixture holds'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('No matching signature in the store.');
    h.out.length = 0;
    expect(await run(['sessions', 'recall', '--text', 'a phrase no fixture holds'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain(MISS_TEXT);
  });

  it('books on an empty store says it is empty and names the command that fills it', async () => {
    const { deps, out } = bare();
    expect(await run(['sessions', 'books'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain(emptyBooks('prompts'));
    expect(emptyBooks('prompts')).toContain('oars sessions deposit');
    out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'pull'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain(emptyBooks('pulls'));
  });
});
