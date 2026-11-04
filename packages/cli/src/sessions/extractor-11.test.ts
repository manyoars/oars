// EXTRACTOR 11 (t811, pool vocabulary spec Section 2): raw `agentType`, `keys`, and `frameId` with the joined frame are class A, and the pooled shell form is
// computed at deposit from what the account store holds. A store written at 10 is re-derived from its log alone.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { PRIVATE_PROGRAM, projectShell, projectStoredShell } from './projection.js';
import { makeRedactor } from './redact.js';
import { EXTRACTOR_VERSION, type ToolObservation } from './schema.js';
import { deposit, derive, loadStore, paths, refresh } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';
import { readVocabulary } from './vocab-load.js';

afterEach(cleanup);

// A fictional name: no real project, person, or customer.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const line = (value: object): string => JSON.stringify(value);

const COMMANDS = [`git commit --amend --message=${PLANTED}`, 'ls -a -l', `grep ${PLANTED}`, 'acme-deploy --prod', 'git push --force', `git ${PLANTED} --acme-flag`, 'git -C repo status'];

const shellSession = (): string =>
  [
    line({ type: 'user', uuid: 'u0', timestamp: '2026-06-01T00:00:01.000Z', version: '2.1.300', cwd: '/w', message: { role: 'user', content: 'run them' } }),
    ...COMMANDS.map((command, i) =>
      line({
        type: 'assistant', uuid: `m${String(i)}`, timestamp: '2026-06-01T00:00:02.000Z', version: '2.1.300', cwd: '/w',
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `t${String(i)}`, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ),
  ].join('\n');

const captured = (): ToolObservation[] =>
  captureSession({ text: shellSession(), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor(), salt: 'salt', sid: null, repoRoot: () => null, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } }).tools;

describe('EXTRACTOR_VERSION 11', () => {
  it('is 11, the version that moves agentType, keys, and frameId to class A', () => {
    expect(EXTRACTOR_VERSION).toBe('11');
  });

  it('re-derives a store written at 10 from its log alone, keeping every class A field it held', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const before = await loadStore(staged.storeDir);
    // The store as version 10 left it: its derived records stamped '10'. The transcripts are gone, so nothing can be read from raw.
    writeFileSync(paths(staged.storeDir).derived, readFileSync(paths(staged.storeDir).derived, 'utf8').replaceAll(`"v":"${EXTRACTOR_VERSION}"`, '"v":"10"'));
    expect(readFileSync(paths(staged.storeDir).derived, 'utf8')).not.toContain(`"v":"${EXTRACTOR_VERSION}"`);
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z');
    const written = readFileSync(paths(staged.storeDir).derived, 'utf8');
    expect(written).toContain(`"v":"${EXTRACTOR_VERSION}"`);
    expect(written).not.toContain('"v":"10"');
    const after = await loadStore(staged.storeDir);
    expect(after.tools).toEqual(before.tools);
    expect(after.tools.some((tool) => tool.keys.length > 0)).toBe(true);
    expect(derive(after, '2026-06-10T00:00:00.000Z').signatures.every((record) => record.v === EXTRACTOR_VERSION)).toBe(true);
  });

  it('leaves no staged pooled file or outbox behind for the migration to delete (Q2)', async () => {
    const staged = stage();
    addProject(staged, 'proj', 'shell', shellSession().split('\n'));
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    // The store on disk, not the table of paths the code knows: a deposit writes no file or folder named for a pool, an outbox, or a staged batch.
    // (`pool-replica/` is the signed slice `oars pool pull` keeps; a deposit never writes it.)
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => [join(dir, entry.name), ...(entry.isDirectory() ? walk(join(dir, entry.name)) : [])]);
    const written = walk(staged.storeDir);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((path) => /pool|outbox|staged/i.test(path.slice(staged.storeDir.length)))).toEqual([]);
  });
});

describe('the shell form projected from the account store (Q5)', () => {
  it('projects program and subcommand from the A copy of target, and flags from the steps CAPTURE 9 and later hold', () => {
    const tools = captured();
    expect(tools.map((tool) => projectStoredShell(vocab, tool))).toEqual([
      { program: 'git', subcommand: 'commit', flags: ['--amend', '--message'] },
      { program: 'ls', subcommand: null, flags: ['-a', '-l'] },
      { program: 'grep', subcommand: null, flags: [] },
      PRIVATE_PROGRAM,
      { program: 'git', subcommand: 'push', flags: ['--force'] },
      { program: 'git', subcommand: null, flags: [] },
      { program: 'git', subcommand: null, flags: ['-C'] },
    ]);
  });

  it('loses the subcommand of a call whose first plain word is not the subcommand and states the loss by count: 1 of 7 fixture calls', () => {
    // `shellTarget` stores the first plain token after the program, so `git -C repo status` is stored as `git repo`.
    const stored = captured().map((tool) => projectStoredShell(vocab, tool));
    const fromRaw = COMMANDS.map((command) => projectShell(vocab, command, makeRedactor()).commands[0]);
    const lost = fromRaw.filter((read, i) => read?.subcommand !== null && stored[i]?.subcommand === null);
    expect(lost).toEqual([{ program: 'git', subcommand: 'status', flags: ['-C'] }]);
    expect(stored[COMMANDS.length - 1]).toEqual({ program: 'git', subcommand: null, flags: ['-C'] });
  });

  it('loses the flags of a record captured before CAPTURE 9 and states the loss by count: 4 of 7 fixture calls lose their flags', () => {
    const tools = captured();
    const withSteps = tools.map((tool) => projectStoredShell(vocab, tool).flags.length > 0);
    // The same calls as a CAPTURE 8 store holds them: the A copy of `target` and no `steps`.
    const before9 = tools.map((tool) => projectStoredShell(vocab, { tool: tool.tool, target: tool.target }));
    expect(withSteps.filter(Boolean)).toHaveLength(4);
    expect(before9.filter((projected) => projected.flags.length > 0)).toHaveLength(0);
    expect(JSON.stringify(before9)).not.toContain(PLANTED);
  });

  it('projects a target it cannot read back to private: cut at the subcommand limit, masked by redaction, or not a shell call', () => {
    const shell = (target: string | null, tool = 'Bash') => projectStoredShell(vocab, { tool, target });
    expect(shell(`git ${'x'.repeat(30)}`)).toEqual(PRIVATE_PROGRAM);
    expect(shell('git <secret>')).toEqual(PRIVATE_PROGRAM);
    expect(shell('a b c')).toEqual(PRIVATE_PROGRAM);
    expect(shell(null)).toEqual(PRIVATE_PROGRAM);
    expect(shell('')).toEqual(PRIVATE_PROGRAM);
    expect(shell('0123456789abcdef', 'Read')).toEqual(PRIVATE_PROGRAM);
    expect(shell('git')).toEqual({ program: 'git', subcommand: null, flags: [] });
  });
});
