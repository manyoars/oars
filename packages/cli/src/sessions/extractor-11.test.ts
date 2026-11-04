// EXTRACTOR 11 (t811, pool vocabulary spec Section 2): raw `agentType`, `keys`, and `frameId` with the joined frame are class A, and the pooled shell form is
// computed at deposit from what the account store holds. A store written at 10 is re-derived from its log alone.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { PRIVATE_PROGRAM, projectShell, projectStoredShell, type ProjectedShell } from './projection.js';
import { PRIVATE, PUBLIC_PROGRAMS } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';
import { EXTRACTOR_VERSION, type ToolObservation } from './schema.js';
import { deposit, derive, loadStore, paths, refresh } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';
import { readVocabulary, type Vocabulary } from './vocab-load.js';

afterEach(cleanup);

// A fictional name: no real project, person, or customer.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const line = (value: object): string => JSON.stringify(value);

const COMMANDS = [`git commit --amend --message=${PLANTED}`, 'ls -a -l', `grep ${PLANTED}`, 'acme-deploy --prod', 'git push --force', `git ${PLANTED} --acme-flag`, 'git -C repo status', 'cd /w && git commit --amend', 'cat f | grep x | sort', 'bash -c "git push --force"'];

const shellSession = (commands: readonly string[] = COMMANDS): string =>
  [
    line({ type: 'user', uuid: 'u0', timestamp: '2026-06-01T00:00:01.000Z', version: '2.1.300', cwd: '/w', message: { role: 'user', content: 'run them' } }),
    ...commands.map((command, i) =>
      line({
        type: 'assistant', uuid: `m${String(i)}`, timestamp: '2026-06-01T00:00:02.000Z', version: '2.1.300', cwd: '/w',
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `t${String(i)}`, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ),
  ].join('\n');

const captured = (commands: readonly string[] = COMMANDS): ToolObservation[] =>
  captureSession({ text: shellSession(commands), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor(), salt: 'salt', sid: null, repoRoot: () => null, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } }).tools;

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
    // The other class A fields Item 4 moves: the joined frame and its id on sessions, the frame on prompts, and a subagent's agentType.
    expect(after.sessions).toEqual(before.sessions);
    expect(after.subagents).toEqual(before.subagents);
    expect(after.prompts.map((prompt) => prompt.frame)).toEqual(before.prompts.map((prompt) => prompt.frame));
    expect(before.prompts.some((prompt) => prompt.frame !== undefined)).toBe(true);
    expect(before.sessions.some((session) => session.frame !== undefined && session.frameId !== undefined)).toBe(true);
    expect(after.tools.some((tool) => tool.keys.length > 0)).toBe(true);
    expect(derive(after, '2026-06-10T00:00:00.000Z').signatures.every((record) => record.v === EXTRACTOR_VERSION)).toBe(true);
  });

  it('leaves no staged pooled file or outbox behind for the migration to delete (Q2)', async () => {
    const staged = stage();
    addProject(staged, 'proj', 'shell', shellSession().split('\n'));
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    // The store on disk, not the table of paths the code knows: a deposit writes no file or folder named for a pool, an outbox, or a staged batch.
    // (`pool-replica/` is the signed slice `oars pool fetch` keeps; a deposit never writes it.)
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => [join(dir, entry.name), ...(entry.isDirectory() ? walk(join(dir, entry.name)) : [])]);
    const written = walk(staged.storeDir);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((path) => /pool|outbox|staged/i.test(path.slice(staged.storeDir.length)))).toEqual([]);
  });
});

const UNREAD: ProjectedShell = { commands: [PRIVATE_PROGRAM], programs: [PRIVATE] };

describe('the shell form projected from the account store (Q5)', () => {
  const one = (program: string, subcommand: string | null, flags: string[]) => ({ program, subcommand, flags });
  const projected = (commands: readonly string[]) => captured(commands).map((tool) => projectStoredShell(vocab, tool));
  // The same calls as a CAPTURE 8 store holds them: the A copy of `target` and no `steps`.
  const withoutSteps = (commands: readonly string[]) => captured(commands).map((tool) => projectStoredShell(vocab, { tool: tool.tool, target: tool.target }));
  const lossesOf = (kept: readonly ProjectedShell[], raw: readonly ProjectedShell[], pick: (shell: ProjectedShell) => unknown): number => kept.filter((shell, i) => JSON.stringify(pick(shell)) !== JSON.stringify(pick(raw[i] ?? UNREAD))).length;
  const subcommandsOf = (shell: ProjectedShell) => shell.commands.flatMap(({ subcommand }) => subcommand ?? []);
  const flagsOf = (shell: ProjectedShell) => shell.commands.flatMap(({ flags }) => flags);

  it('projects every command of a call from its steps: a pipeline, an && chain, a cd hop, a bash -c body, and a git -C call keep their programs, subcommands, and flags', () => {
    const forms = ['cat f | grep x | sort', 'npm test && git push --force', 'cd /w && git commit --amend', 'bash -c "git push --force"', 'git -C repo status'];
    expect(projected(forms)).toEqual([
      { commands: [one('cat', null, []), one('grep', null, []), one('sort', null, [])], programs: ['cat', 'grep', 'sort'] },
      { commands: [one('npm', 'test', []), one('git', 'push', ['--force'])], programs: ['npm', 'git'] },
      { commands: [one('cd', null, []), one('git', 'commit', ['--amend'])], programs: ['cd', 'git'] },
      { commands: [one('git', 'push', ['--force'])], programs: ['git'] },
      { commands: [one('git', 'status', ['-C'])], programs: ['git'] },
    ]);
  });

  it('projects every fixture call from its steps exactly as the raw command reads: no loss for a record with steps', () => {
    const raw = COMMANDS.map((command) => projectShell(vocab, command, makeRedactor()));
    expect(projected(COMMANDS)).toEqual(raw);
    expect(JSON.stringify(projected(COMMANDS))).not.toContain(PLANTED);
  });

  it('every flag of a snapshot-only program and a curated program\'s uncurated flag are lost stored, and the program kept (3 of 3 flags, 0 of 3 programs)', () => {
    // `ffmpeg` is in the snapshot but not the curated programs, so its step is `<literal>` with no flags and its program is read from the call's `segments`; `-exec` is
    // outside the curated flags, so `find`'s step keeps its own program and stores that flag as `<literal>`.
    const forms = ['ffmpeg -i in out', 'cd /w && ffmpeg -i in out', 'find . -exec acme-deploy {} ;'];
    const raw = forms.map((command) => projectShell(vocab, command, makeRedactor()));
    const stored = projected(forms);
    expect(raw.flatMap(flagsOf)).toEqual(['-i', '-i', '-exec']);
    expect(lossesOf(stored, raw, flagsOf)).toBe(3);
    expect(lossesOf(stored, raw, (shell) => shell.programs)).toBe(0);
    expect(lossesOf(stored, raw, subcommandsOf)).toBe(0);
    expect(stored[1]?.programs).toEqual(['cd', 'ffmpeg']);
    expect(JSON.stringify(stored)).not.toContain('acme-deploy');
  });

  it('reads the program of a literal step from the same parse as the step: stored programs equal the raw command for eight forms', () => {
    // `target` comes from another parser (`shellTarget`); `segments` and `steps` come from the same commands (`readShell`), so they pair command for command.
    const forms = [
      'MSG="say hello" acme-deploy --x',
      'MSG="run ffmpeg" acme-deploy --x',
      '"say ffmpeg"; acme-deploy',
      '#!/usr/bin/ffmpeg\nacme-deploy',
      'bash -c "ffmpeg -i a"',
      'timeout 5 ffmpeg a',
      'nohup ffmpeg -i a',
      'cd /w && ffmpeg -i in out',
    ];
    const raw = forms.map((command) => projectShell(vocab, command, makeRedactor()));
    const stored = projected(forms);
    expect(stored.map((shell) => shell.programs)).toEqual(raw.map((shell) => shell.programs));
    expect(stored.map(subcommandsOf)).toEqual(raw.map(subcommandsOf));
    // The flags of the three wrapped forms are still lost where there were any (a segment holds none): 2 of 3.
    expect(lossesOf(stored.slice(4, 7), raw.slice(4, 7), flagsOf)).toBe(2);
    // Not vacuous: the snapshot-only program is kept, and the private one is not.
    expect(stored.slice(4).flatMap((shell) => shell.programs)).toEqual(['ffmpeg', 'ffmpeg', 'ffmpeg', 'cd', 'ffmpeg']);
    expect(stored.slice(0, 2).map((shell) => shell.programs)).toEqual([[PRIVATE], [PRIVATE]]);
    // The program of a call that shows no segments cannot be read back, so it is private rather than a guess from the target.
    const [call] = captured(['MSG="say hello" acme-deploy --x']);
    expect(projectStoredShell(vocab, { tool: 'Bash', target: call?.target ?? null, steps: call?.steps }).programs).toEqual([PRIVATE]);
    expect(projectStoredShell(vocab, { tool: 'Bash', target: call?.target ?? null, steps: call?.steps, segments: [] }).programs).toEqual([PRIVATE]);
  });

  it('caps the program list of a long pipeline at pipe_max and keeps every command', () => {
    const [shell] = projected(['cat a | sort | uniq | head | wc | tr x y']);
    expect(shell?.commands).toHaveLength(6);
    expect(shell?.programs).toEqual(['cat', 'sort', 'uniq', 'head']);
  });

  it('reads no subcommand from a word cut at the segment limit: a snapshot-only program that lists a 30-character subcommand does not match a longer word', () => {
    // A `run` word is cut at 30 characters (RUN_WORD_CHARS), so a 30-character word may be the prefix of a longer private one.
    const listed = (sub: string): Vocabulary => ({ ...vocab, programs: new Map([...vocab.programs, ['snaponly', { subs: new Set([sub]), flags: new Set<string>() }]]) });
    const cut = 'a'.repeat(30);
    const short = 'a'.repeat(29);
    const subOf = (v: Vocabulary, word: string): string | null => captured([`snaponly ${word}`]).map((tool) => projectStoredShell(v, tool).commands[0]?.subcommand)[0] ?? null;
    expect(subOf(listed(cut), `${cut}PrivateTail`)).toBeNull();
    expect(subOf(listed(cut), cut)).toBeNull();
    // A word under the limit is whole, so a listed one still reads.
    expect(subOf(listed(short), short)).toBe(short);
  });

  it('projects a step the curated list does not name from the segments, so a program only the snapshot lists stays admitted, first or later', () => {
    const snapshotOnly = [...vocab.programs.keys()].find((name) => !PUBLIC_PROGRAMS.has(name) && /^[a-z]+$/.test(name));
    expect(snapshotOnly).toBeDefined();
    const name = snapshotOnly ?? '';
    expect(projected([`${name} --version`])).toEqual([{ commands: [one(name, null, [])], programs: [name] }]);
    expect(projected(['acme-deploy --prod'])).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
    expect(projected([`cd /w && ${name}`])[0]?.programs).toEqual(['cd', name]);
  });

  it('projects a private program behind a wrapper as private, never as the wrapper: bash -c and timeout', () => {
    // The step reads `<literal>` and its segment names the private program, so the wrapper in front is never read.
    expect(projected(['bash -c "acme-deploy --x"', 'timeout 5 acme-deploy', 'sudo acme-deploy --x', 'env X=1 acme-deploy'])).toEqual(Array.from({ length: 4 }, () => ({ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] })));
    expect(projectShell(vocab, 'bash -c "acme-deploy --x"', makeRedactor()).programs).toEqual([PRIVATE]);
    expect(projectShell(vocab, 'timeout 5 acme-deploy', makeRedactor()).programs).toEqual([PRIVATE]);
  });

  it('projects a private program behind a block word, a wrapper, an assignment, or a shell as private, never as the word in front', () => {
    expect(projected(['if acme-deploy; then ls; fi'])).toEqual([{ commands: [PRIVATE_PROGRAM, one('ls', null, [])], programs: [PRIVATE, 'ls'] }]);
    expect(projectShell(vocab, 'if acme-deploy; then ls; fi', makeRedactor()).programs).toEqual([PRIVATE, 'ls']);
    // What capture's afterPrelude walks past to reach the real program, written out (the projection reads `segments` and does not need the list).
    const words = ['if', 'then', 'elif', 'else', 'elseif', 'do', 'while', 'until', 'fi', 'done', 'esac', 'try', 'finally', '!', 'sudo', 'env', '.', 'command', 'exec', 'nohup', 'nice', 'time', 'call', 'timeout', 'X=1'];
    for (const word of [...words, 'bash -c', 'sh -c', 'zsh -c', 'dash -c', 'pwsh -Command', 'powershell -Command', 'cmd /c']) {
      expect(projected([`${word} acme-deploy --x`]), word).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
    }
    // A lone closing keyword names nothing, so it is not a program either.
    expect(projected(['fi', 'done', 'esac'])).toEqual(Array.from({ length: 3 }, () => ({ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] })));
  });

  // Register row A53: `afterPrelude` compared the raw word, so a wrapper in another case or by path was read as the program itself.
  it('projects a private program behind a wrapper in another case or by path as private, never as the wrapper', () => {
    for (const form of ['IF acme-deploy', 'TIMEOUT 5 acme-deploy', '/usr/bin/timeout 5 acme-deploy', 'Sudo acme-deploy --x', '/usr/bin/env X=1 acme-deploy', 'C:\\Windows\\Timeout.exe 5 acme-deploy']) {
      expect(projected([form]), form).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
      expect(projectShell(vocab, form, makeRedactor()).programs, form).toEqual([PRIVATE]);
    }
    // A quoted word is an argument, not a wrapper: `"IF"` is the program.
    expect(projected(['"IF" acme-deploy'])[0]?.programs).toEqual(['if']);
  });

  // The wrapper is skipped, not the command: the program behind each form is still read.
  it('reads the program behind a wrapper in another case or by path', () => {
    for (const form of ['/usr/bin/timeout 5 git status', 'TIMEOUT 5 git status', 'IF git status', 'Sudo git status']) {
      expect(projected([form])[0]?.programs, form).toEqual(['git']);
    }
  });

  // A block word is never written with a path, so a script named like one is the program (review of t826: `./do git push --force` read as `git push --force`).
  it('reads a path or a script named like a block word as the program it is, never skips it as a keyword', () => {
    const runs = (form: string): readonly (string | undefined)[] | undefined => captured([form])[0]?.segments?.map((segment) => segment.run);
    expect(runs('./do git push --force')).toEqual(['do git push']);
    expect(runs('./done')).toEqual(['done']);
    expect(runs('./do.cmd')).toEqual(['do']);
    // The same word bare or in another case is the keyword: the command behind it is read.
    expect(runs('DO git status')).toEqual(['git status']);
    expect(projected(['./do git push --force', './done']).map((step) => step.programs)).toEqual([['do'], ['done']]);
    expect(projected(['IF acme-deploy'])[0]?.programs).toEqual([PRIVATE]);
  });

  // Register row A53: a program whose basename holds a space cannot be told from a program and a word in `run`, which joins them with one space.
  it('projects a program whose basename holds a space as private, never as the program and subcommand it spells', () => {
    const form = '"/opt/my tools/git push" --x';
    expect(projected([form])).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
    expect(projectShell(vocab, form, makeRedactor()).programs).toEqual([PRIVATE]);
    // The stored word carries the boundary the line `run` cannot: no name from the basename is kept at all.
    const [call] = captured([form]);
    expect(call?.segments?.map((segment) => segment.run)).toEqual(['<literal>']);
    // A directory that holds the space is not the program: `/opt/my tools/git push` as two words is still git.
    expect(projected(['"/opt/my tools/git" push'])[0]?.commands).toEqual([one('git', 'push', [])]);
  });

  it('projects a program cut at the 30-character limit as private, because the stored word may be the front of a longer private one', () => {
    const listed = 'systemd-tty-ask-password-agent';
    expect(vocab.programs.has(listed) || PUBLIC_PROGRAMS.has(listed)).toBe(true);
    expect(listed).toHaveLength(30);
    for (const form of [`${listed}-acme`, `${listed}-acme --x`, `sudo ${listed}-acme`]) {
      expect(projected([form]), form).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
      expect(projectShell(vocab, form, makeRedactor()).programs, form).toEqual([PRIVATE]);
    }
    // The listed name itself, uncut and exactly as long as the limit, is also read as private: a stored word this long cannot be told from a cut one.
    expect(projected([listed])).toEqual([{ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] }]);
    // A shorter listed name still pools.
    expect(projected(['git status'])[0]?.programs).toEqual(['git']);
  });

  it('projects a Bash step whose identity is null as private', () => {
    // Capture gives a shell call only a shell identity, so the step is rewritten to the one other shape a stored step can hold.
    const [call] = captured(['git status']);
    const steps = (call?.steps ?? []).map((step) => ({ ...step, identity: null }));
    expect(steps).toHaveLength(1);
    expect(projectStoredShell(vocab, { tool: 'Bash', target: call?.target ?? null, steps })).toEqual({ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] });
  });

  it('loses the subcommands of a record without steps and states the loss by count: 2 of 10 fixture calls', () => {
    // `shellTarget` stores the first plain token after the program, so `git -C repo status` is stored as `git repo`, and `bash -c "..."` as `bash git`, which projects `bash`.
    const raw = COMMANDS.map((command) => projectShell(vocab, command, makeRedactor()));
    expect(lossesOf(withoutSteps(COMMANDS), raw, subcommandsOf)).toBe(2);
  });

  it('loses the flags of a record without steps and states the loss by count: 6 of 10 fixture calls', () => {
    const raw = COMMANDS.map((command) => projectShell(vocab, command, makeRedactor()));
    expect(lossesOf(withoutSteps(COMMANDS), raw, flagsOf)).toBe(6);
    expect(withoutSteps(COMMANDS).every((shell) => shell.commands.every(({ flags }) => flags.length === 0))).toBe(true);
  });

  it('loses the program list of a record without steps and states the loss by count: 3 of 10 fixture calls', () => {
    const raw = COMMANDS.map((command) => projectShell(vocab, command, makeRedactor()));
    expect(lossesOf(withoutSteps(COMMANDS), raw, (shell) => shell.programs)).toBe(3);
    expect(JSON.stringify(withoutSteps(COMMANDS))).not.toContain(PLANTED);
  });

  it('projects a target it cannot read back to private: cut at the subcommand limit, masked by redaction, or not a shell call', () => {
    const shell = (target: string | null, tool = 'Bash') => projectStoredShell(vocab, { tool, target });
    const unread = { commands: [PRIVATE_PROGRAM], programs: [PRIVATE] };
    expect(shell(`git ${'x'.repeat(30)}`)).toEqual(unread);
    expect(shell('git <secret>')).toEqual(unread);
    expect(shell('a b c')).toEqual(unread);
    expect(shell(null)).toEqual(unread);
    expect(shell('')).toEqual(unread);
    expect(shell('0123456789abcdef', 'Read')).toEqual(unread);
    expect(shell('git')).toEqual({ commands: [one('git', null, [])], programs: ['git'] });
  });
});
