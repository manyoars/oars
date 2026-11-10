import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { EMPTY_RECALL, emptyBooks, savedListNote } from './empty-state.js';
import { MISS_TEXT } from './recall-render.js';
import { paths } from './store.js';
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
it('the empty-store line points to sessions try first, then says what deposit reads and where it puts it', () => {    for (const line of [EMPTY_RECALL, emptyBooks('prompts')]) {      expect(line.indexOf('oars sessions try')).toBeGreaterThan(-1);      expect(line.indexOf('oars sessions try')).toBeLessThan(line.indexOf('oars sessions deposit'));      expect(line).toContain("reads this machine's coding-agent session logs into a local store");    }  });
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
    out.length = 0;
    expect(await run(['sessions', 'books', '--by', 'package'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain(emptyBooks('public package pulls'));
  });

  it('recall --context on an empty store says it is empty and names the command that fills it', async () => {
    const { deps, out } = bare();
    expect(await run(['sessions', 'recall', '--context'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toBe(`${EMPTY_RECALL}\n`);
  });

  it('recall --context over a populated index answers without loading the store, even when the store cannot load', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    await run(['sessions', 'deposit'], h.deps);
    h.out.length = 0;
    rmSync(paths(staged.storeDir).observations);
    mkdirSync(paths(staged.storeDir).observations);
    expect(await run(['sessions', 'recall', '--context', '--cwd', join('elsewhere', 'x')], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('Nothing recurs');
  });

  it('a plain deposit that applies a saved --allow list says so and names where it is saved; without a saved list it says nothing', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('saved by an earlier run');
    h.out.length = 0;
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('saved by an earlier run');
    h.out.length = 0;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('');
    expect(text).toContain(`Used the --allow list saved by an earlier run (proj), kept in ${paths(staged.storeDir).state}.`);
    expect(text.indexOf('not on the allowlist.')).toBeLessThan(text.indexOf('saved by an earlier run'));
  });

  it('the saved-list note shortens a long list', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(savedListNote(entries, ['a'], 'state.json')).toEqual(['Used the --allow list saved by an earlier run (b, c, d, e, f, and 1 more), kept in state.json. `--allow` adds folders to it and `--deny` leaves one out.']);
  });

  it('a saved denial alone prints no saved-list note, and an --allow over a saved denial prints none either', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'deposit', '--deny', 'x'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('saved by an earlier run');
    h.out.length = 0;
    expect(await run(['sessions', 'deposit', '--allow', 'proj'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).not.toContain('saved by an earlier run');
  });

  it('a saved list that holds a denial names only its allow entries', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await run(['sessions', 'deposit', '--allow', 'proj', '--deny', 'x'], h.deps)).toBe(ExitCode.OK);
    h.out.length = 0;
    expect(await run(['sessions', 'deposit'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('saved by an earlier run (proj), kept in');
  });

  it('a deposit that finds nothing lists only the sources its allowlist reads', async () => {
    const { deps, out, staged, cursor } = bare();
    expect(await run(['sessions', 'deposit', '--allow', 'no-such-folder'], deps)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text).toContain('Found no sessions. Looked in:');
    expect(text).toContain(`  Claude Code: ${staged.projectsRoot}`);
    expect(text).not.toContain(cursor);
    out.length = 0;
    expect(await run(['sessions', 'deposit', '--allow', 'cursor'], deps)).toBe(ExitCode.OK);
    expect(out.join('')).toContain(`  Cursor: ${cursor} (0 sessions read)`);
  });
});
