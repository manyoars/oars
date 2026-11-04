import { describe, expect, it } from 'vitest';
import { PIPE_MAX, PRIVATE, SEED_TOP } from './public-vocabulary.js';
import { projectHarnessVersion, projectModel, projectPackage, projectShell, projectTool, shellReader } from './projection.js';
import { step, tool as toolRecord } from './pool-fixture.js';
import { makeRedactor } from './redact.js';
import { readVocabulary } from './vocab-load.js';

// A fictional name: no real project, person, or customer. It stands for any identifier that must never pool.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const redact = makeRedactor();
const shell = (command: string) => projectShell(vocab, command, redact);

describe('shell form to program, subcommand, and flags', () => {
  it('pools a grep call as the program alone, the pattern gone', () => {
    expect(shell(`grep ${PLANTED}`)).toEqual({ commands: [{ program: 'grep', subcommand: null, flags: [] }], programs: ['grep'] });
  });

  it('pools a program outside the program vocabulary as private', () => {
    expect(shell('acme-deploy --prod')).toEqual({ commands: [{ program: PRIVATE, subcommand: null, flags: [] }], programs: [PRIVATE] });
  });

  it('keeps an admitted subcommand and the admitted flag names, never a value', () => {
    expect(shell(`git commit --amend --message=${PLANTED}`).commands).toEqual([{ program: 'git', subcommand: 'commit', flags: ['--amend', '--message'] }]);
    expect(shell(`ls -a -l ${PLANTED}`).commands).toEqual([{ program: 'ls', subcommand: null, flags: ['-a', '-l'] }]);
  });

  it('drops an unlisted subcommand or flag without counting it, since its program already pools', () => {
    expect(shell(`git ${PLANTED} --acme-flag`)).toEqual({ commands: [{ program: 'git', subcommand: null, flags: [] }], programs: ['git'] });
  });

  it('reads a pipeline or && chain as the ordered program list, capped at pipe_max', () => {
    expect(shell(`cat ${PLANTED} | grep x | sort && acme-deploy`).programs).toEqual(['cat', 'grep', 'sort', PRIVATE]);
    const long = shell('ls | cat | sort | uniq | wc | head').programs;
    expect(long).toHaveLength(PIPE_MAX);
    expect(long).toEqual(['ls', 'cat', 'sort', 'uniq']);
  });

  it('projects a command the parser cannot read to private, never to its text', () => {
    for (const unreadable of [`$${PLANTED} --flag`, '', '   ']) expect(shell(unreadable).programs).toEqual([PRIVATE]);
  });
});

describe('a shell step of a harness whose shell tool is not Bash or PowerShell', () => {
  it('reads as the program and subcommand it ran, through the shared reader', () => {
    const call = toolRecord('s1', 0, 'run_terminal_cmd', { steps: [step(0, 0, 'shell.exec', { native: 'run_terminal_cmd', identity: { program: 'git', sub: 'push', flags: ['--force'] } })] });
    expect(shellReader(vocab)(call)).toEqual([{ program: 'git', subcommand: 'push', flags: ['--force'] }]);
  });

  it('still projects a non-shell tool without a shell step to private', () => {
    expect(shellReader(vocab)(toolRecord('s1', 0, 'Read', { steps: [step(0, 0, 'file.read')] }))).toEqual([{ program: PRIVATE, subcommand: null, flags: [] }]);
  });
});

describe('packages', () => {
  it('admits a seed_top name as itself, with a version the snapshot lists', () => {
    const [name = '', versions = new Set<string>()] = [...(vocab.packages.get('npm')?.seed ?? [])][0] ?? [];
    expect(name).not.toBe('');
    const version = [...versions][0] ?? '';
    expect(projectPackage(vocab, 'npm', name.toUpperCase(), version)).toEqual({ package: `npm:${name}`, packageVersion: version });
    expect(projectPackage(vocab, 'npm', name, '0.0.0-acme')).toEqual({ package: `npm:${name}`, packageVersion: PRIVATE });
    expect(projectPackage(vocab, 'npm', name, null)).toEqual({ package: `npm:${name}`, packageVersion: null });
  });

  it.each(['npm', 'pypi', 'crates', 'rubygems', 'homebrew'])('projects a %s name that resolves but sits outside seed_top to private', (ecosystem) => {
    const snapshot = vocab.packages.get(ecosystem);
    const outside = [...(snapshot?.resolved ?? [])][0] ?? '';
    expect(outside).not.toBe('');
    expect(snapshot?.seed.has(outside)).toBe(false);
    expect(projectPackage(vocab, ecosystem, outside, '1.0.0')).toEqual({ package: PRIVATE, packageVersion: null });
  });

  it('projects any name to private where the registry publishes no download counts, and any unknown ecosystem', () => {
    for (const ecosystem of ['go', 'maven', 'plugin', 'unknown', 'constructor', '__proto__']) expect(projectPackage(vocab, ecosystem, 'github.com/acme/widget', '1.0.0')).toEqual({ package: PRIVATE, packageVersion: null });
    expect(projectPackage(vocab, 'npm', PLANTED, '1.0.0')).toEqual({ package: PRIVATE, packageVersion: null });
  });

  it('seeds exactly seed_top names for a ranked ecosystem and none for the others', () => {
    // The shipped files carry the parameter the code names, so SEED_TOP cannot drift from what the script wrote.
    for (const ecosystem of ['npm', 'pypi', 'crates', 'rubygems', 'homebrew']) {
      expect(vocab.packages.get(ecosystem)?.seedTop).toBe(SEED_TOP);
      expect(vocab.packages.get(ecosystem)?.seed.size).toBe(SEED_TOP);
    }
    for (const ecosystem of ['go', 'maven']) {
      expect(vocab.packages.get(ecosystem)?.seedTop).toBe(0);
      expect(vocab.packages.get(ecosystem)?.seed.size).toBe(0);
    }
  });
});

describe('tool, model, and harness version', () => {
  it('admits a built-in tool and an MCP tool admitted on both parts', () => {
    expect(projectTool('Bash')).toBe('Bash');
    expect(projectTool('mcp__claude-in-chrome__navigate')).toBe('mcp:claude-in-chrome:navigate');
  });

  it('projects anything else to mcp:private or private', () => {
    expect(projectTool(`mcp__${PLANTED}__merge`)).toBe('mcp:private');
    expect(projectTool(`mcp__claude-in-chrome__${PLANTED}`)).toBe('mcp:private');
    expect(projectTool(PLANTED)).toBe(PRIVATE);
  });

  it('admits a published model id and a harness release up to the snapshot', () => {
    const model = [...vocab.models][0] ?? '';
    expect(projectModel(vocab, model.toUpperCase())).toBe(model);
    expect(projectModel(vocab, PLANTED)).toBe(PRIVATE);
    const release = [...(vocab.harnessVersions.get('claude-code') ?? [])][0] ?? '';
    expect(projectHarnessVersion(vocab, 'claude-code', release)).toBe(release);
    expect(projectHarnessVersion(vocab, 'claude-code', '999.0.0')).toBe(PRIVATE);
    expect(projectHarnessVersion(vocab, 'nobody', release)).toBe(PRIVATE);
  });
});
