import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { slugOf } from './allow.js';
import { sessionsContextWrite, sessionsDeposit, type SessionsDeps } from './command.js';
import { AGENTS, BEGIN, BOTH_NOTICE, chooseFile, CLAUDE, END, gitTop, holdsMarker, keepLines, planWrite } from './context-write.js';
import type { HookIndex, IndexedSignature } from './hook-index.js';
import { addProject, cleanup, settledClock, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const row = (sig: string, recent = 3): IndexedSignature => ({ sig, sessions: recent, recent, followed: [['Edit', 2]], harness: [] });
const SIGS = ['Bash | unexpected EOF while looking for matching quote', 'Bash | tsc: Cannot find module <path>'];

/** A temp repository (a `.git` folder) whose project folder has an index holding `sigs`, and a harness reading that store. */
const setup = (sigs: readonly string[] = SIGS, env: NodeJS.ProcessEnv = {}) => {
  const repo = mkdtempSync(join(tmpdir(), 'oars-ctx-write-'));
  mkdirSync(join(repo, '.git'));
  const staged = stage(slugOf(repo));
  mkdirSync(staged.storeDir, { recursive: true });
  const index: HookIndex = { at: '', redactDomains: [], signatures: {}, projects: { [slugOf(repo)]: sigs.map((sig) => row(sig)) } };
  writeFileSync(join(staged.storeDir, 'hook-index.json'), JSON.stringify(index));
  const h = harness(env);
  h.deps.sessions = staged.runtime;
  const spool: { type: string; fields: object }[] = [];
  const sessionDeps: SessionsDeps = { sessions: staged.runtime, install: undefined, now: () => Date.parse('2026-11-21T12:00:00Z'), telemetry: (type, fields) => spool.push({ type, fields }) };
  return { repo, staged, spool, sessionDeps, ...h };
};

/** Deposits one session of the repository's project that sat on `branch`, so the store records the branch the recall lines must not carry; the index the test wrote stays. */
const recordBranch = async (ctx: ReturnType<typeof setup>, branch: string): Promise<void> => {
  const lines = [{ type: 'user', uuid: 'b-1', parentUuid: null, isSidechain: false, timestamp: '2026-05-28T20:26:45.000Z', version: '2.1.300', cwd: ctx.repo, gitBranch: branch, message: { role: 'user', content: 'run the build' } }];
  addProject(ctx.staged, slugOf(ctx.repo), 'branchy', lines.map((line) => JSON.stringify(line)));
  const index = readFileSync(join(ctx.staged.storeDir, 'hook-index.json'), 'utf8');
  await sessionsDeposit({ ...ctx.sessionDeps, now: settledClock }, { allow: [slugOf(ctx.repo)], allowFiles: [], redactDomains: [] });
  writeFileSync(join(ctx.staged.storeDir, 'hook-index.json'), index);
};

const CONTEXT = { top: 5, maxChars: 1200 };
const write = (ctx: ReturnType<typeof setup>, file?: string, dryRun = false, env: NodeJS.ProcessEnv = {}) => sessionsContextWrite(ctx.sessionDeps, { cwd: ctx.repo, ...CONTEXT }, { file, dryRun }, env);
const at = (ctx: ReturnType<typeof setup>, name: string): string => join(ctx.repo, name);
const read = (ctx: ReturnType<typeof setup>, name: string): string => readFileSync(at(ctx, name), 'utf8');

describe('--write: the file and the markers', () => {
  it('creates a missing file holding the begin marker, the recall lines, the day, and the end marker', async () => {
    const ctx = setup();
    const result = await write(ctx);
    const lines = read(ctx, AGENTS).split('\n');
    expect(lines[0]).toBe(BEGIN);
    expect(lines[1]).toContain('oars recall: errors that recur');
    expect(lines.at(-3)).toBe('Lines last changed: 2026-11-21.');
    expect(lines.at(-2)).toBe(END);
    expect(lines.at(-1)).toBe('');
    expect(result.text).toContain(`Wrote ${at(ctx, AGENTS)}`);
    expect(Reflect.get(Reflect.get(result.document, 'write'), 'created')).toBe(true);
  });

  it('appends after a file with no markers, leaving its bytes as they were, with a blank line between', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), '# Rules\n\nBe kind.');
    await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text.startsWith('# Rules\n\nBe kind.\n\n' + BEGIN + '\n')).toBe(true);
    expect(text.endsWith(END + '\n')).toBe(true);
  });

  it('replaces only the text between one pair of markers and leaves every byte outside them', async () => {
    const ctx = setup();
    const before = '# Rules\n\n';
    const after = '\n## Other\nkeep me  \n';
    writeFileSync(at(ctx, AGENTS), `${before}${BEGIN}\nstale line\nLines last changed: 2026-01-01.\n${END}${after}`);
    await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text.startsWith(`${before}${BEGIN}\n`)).toBe(true);
    expect(text.endsWith(`${END}${after}`)).toBe(true);
    expect(text).not.toContain('stale line');
    expect(text).toContain('Lines last changed: 2026-11-21.');
  });

  it('keeps CRLF line endings outside the markers and writes the block with them', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), `# Rules\r\n${BEGIN}\r\nold\r\n${END}\r\ntail\r\n`);
    await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text.startsWith(`# Rules\r\n${BEGIN}\r\n`)).toBe(true);
    expect(text.endsWith(`${END}\r\ntail\r\n`)).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('appends with the file’s own line ending', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), '# Rules\r\n');
    await write(ctx);
    expect(read(ctx, AGENTS).replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('refuses two pairs and changes nothing', async () => {
    const ctx = setup();
    const original = `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`;
    writeFileSync(at(ctx, AGENTS), original);
    await expect(write(ctx)).rejects.toThrow(/more than one oars recall marker pair/);
    expect(read(ctx, AGENTS)).toBe(original);
  });

  it.each([
    ['a begin marker alone', `x\n${BEGIN}\ny\n`],
    ['an end marker alone', `x\n${END}\ny\n`],
    ['the end before the begin', `${END}\n${BEGIN}\n`],
  ])('refuses %s and changes nothing', async (_name, original) => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), original);
    await expect(write(ctx)).rejects.toThrow(/Nothing was changed/);
    expect(read(ctx, AGENTS)).toBe(original);
  });

  it('writes a file named on the command line, relative to --cwd, and leaves the default files alone', async () => {
    const ctx = setup();
    await write(ctx, 'docs-rules.md');
    expect(existsSync(at(ctx, 'docs-rules.md'))).toBe(true);
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
  });

  it('reports a file it cannot read as unreadable and writes nothing', async () => {
    const ctx = setup();
    mkdirSync(at(ctx, AGENTS));
    await expect(write(ctx)).rejects.toThrow(/Cannot read/);
  });
});

describe('--write: the default file', () => {
  it('is AGENTS.md when neither file exists', async () => {
    const ctx = setup();
    await write(ctx);
    expect(existsSync(at(ctx, AGENTS))).toBe(true);
    expect(existsSync(at(ctx, CLAUDE))).toBe(false);
  });

  it('is CLAUDE.md when only it exists', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, CLAUDE), '# Claude\n');
    const result = await write(ctx);
    expect(read(ctx, CLAUDE)).toContain(BEGIN);
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
    expect(result.text).not.toContain(BOTH_NOTICE);
  });

  it('is AGENTS.md when only it exists', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), '# Agents\n');
    const result = await write(ctx);
    expect(read(ctx, AGENTS)).toContain(BEGIN);
    expect(existsSync(at(ctx, CLAUDE))).toBe(false);
    expect(result.text).not.toContain(BOTH_NOTICE);
  });

  it('is AGENTS.md when both exist and neither holds the markers, with one line saying Claude Code reads it only if CLAUDE.md imports it', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), '# Agents\n');
    writeFileSync(at(ctx, CLAUDE), '# Claude\n');
    const result = await write(ctx);
    expect(read(ctx, AGENTS)).toContain(BEGIN);
    expect(read(ctx, CLAUDE)).toBe('# Claude\n');
    expect(result.text.split('\n').filter((line) => line.includes('reads AGENTS.md only if CLAUDE.md imports it'))).toHaveLength(1);
    expect(BOTH_NOTICE).toBe('Both AGENTS.md and CLAUDE.md exist here. Claude Code reads AGENTS.md only if CLAUDE.md imports it (@AGENTS.md).');
  });

  it('is the file that already holds the markers, though both exist, so a later bare run leaves no second block', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), '# Agents\n');
    writeFileSync(at(ctx, CLAUDE), `# Claude\n${BEGIN}\nold\n${END}\n`);
    const result = await write(ctx);
    expect(read(ctx, CLAUDE)).toContain('oars recall: errors that recur');
    expect(read(ctx, AGENTS)).toBe('# Agents\n');
    expect(result.text).not.toContain(BOTH_NOTICE);
  });

  it('refuses when both files hold the markers, naming both', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, AGENTS), `${BEGIN}\na\n${END}\n`);
    writeFileSync(at(ctx, CLAUDE), `${BEGIN}\nb\n${END}\n`);
    await expect(write(ctx)).rejects.toThrow(/AGENTS\.md and CLAUDE\.md both hold/);
  });

  it('refuses outside a git repository and writes nothing', async () => {
    const ctx = setup();
    const bare = mkdtempSync(join(tmpdir(), 'oars-ctx-bare-'));
    expect(gitTop(bare, () => false)).toBeNull();
    await expect(sessionsContextWrite(ctx.sessionDeps, { cwd: bare, ...CONTEXT }, { file: undefined, dryRun: false }, {})).rejects.toThrow(/not inside a git repository/);
    expect(existsSync(join(bare, AGENTS))).toBe(false);
  });

  it('finds the top level from a subfolder, and from a linked worktree whose `.git` is a file', () => {
    const ctx = setup();
    const sub = join(ctx.repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(gitTop(sub)).toBe(ctx.repo);
    const linked = join(ctx.repo, 'wt');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), 'gitdir: ../.git/worktrees/wt\n');
    expect(gitTop(join(linked, 'src'))).toBe(linked);
  });

  it('says the Claude Code line for an explicit AGENTS.md beside a CLAUDE.md too', async () => {
    const ctx = setup();
    writeFileSync(at(ctx, CLAUDE), '# Claude\n');
    expect((await write(ctx, AGENTS)).text).toContain(BOTH_NOTICE);
  });

  it('chooseFile follows the order on plain text', () => {
    expect(chooseFile({})).toEqual({ file: AGENTS, both: false });
    expect(chooseFile({ [CLAUDE]: 'x' })).toEqual({ file: CLAUDE, both: false });
    expect(chooseFile({ [AGENTS]: 'x', [CLAUDE]: `${BEGIN}\n${END}\n` })).toEqual({ file: CLAUDE, both: true });
    expect(chooseFile({ [AGENTS]: `${END}\n`, [CLAUDE]: 'x' })).toEqual({ file: AGENTS, both: true });
    expect(holdsMarker('plain')).toBe(false);
  });
});

describe('--write: idempotent', () => {
  it('writes nothing when the lines on disk match, keeps the file’s mtime, and says so', async () => {
    const ctx = setup();
    await write(ctx);
    const path = at(ctx, AGENTS);
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(path, old, old);
    const before = readFileSync(path, 'utf8');
    const second = await sessionsContextWrite({ ...ctx.sessionDeps, now: () => Date.parse('2026-12-31T00:00:00Z') }, { cwd: ctx.repo, ...CONTEXT }, { file: undefined, dryRun: false }, {});
    expect(second.text).toContain('already holds these lines: nothing was written');
    expect(statSync(path).mtimeMs).toBe(old.getTime());
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(ctx.spool).toHaveLength(1);
  });

  it('names the day the lines last changed: a changed line takes the new day', async () => {
    const ctx = setup();
    await write(ctx);
    const index: HookIndex = { at: '', redactDomains: [], signatures: {}, projects: { [slugOf(ctx.repo)]: [row('Bash | a brand new failure')] } };
    writeFileSync(join(ctx.staged.storeDir, 'hook-index.json'), JSON.stringify(index));
    await sessionsContextWrite({ ...ctx.sessionDeps, now: () => Date.parse('2026-12-31T00:00:00Z') }, { cwd: ctx.repo, ...CONTEXT }, { file: undefined, dryRun: false }, {});
    expect(read(ctx, AGENTS)).toContain('Lines last changed: 2026-12-31.');
    expect(read(ctx, AGENTS)).toContain('a brand new failure');
  });

  it('keeps the old day for an unchanged block that names one, and tolerates a block with none', () => {
    const lines = ['header', '- a'];
    const stamped = `${BEGIN}\nheader\n- a\nLines last changed: 2026-02-02.\n${END}\n`;
    expect(planWrite(stamped, lines, '2026-11-21')).toMatchObject({ unchanged: true });
    expect(planWrite(stamped, lines, '2026-11-21').block).toContain('Lines last changed: 2026-02-02.');
    expect(planWrite(`${BEGIN}\nheader\n- a\n${END}`, lines, '2026-11-21')).toMatchObject({ unchanged: true });
  });
});

describe('--write: redaction', () => {
  it('drops a line that holds a secret-shaped token or an excluded term, never masks it, and prints how many', async () => {
    const secret = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('');
    const termsFile = join(mkdtempSync(join(tmpdir(), 'oars-ctx-terms-')), 'terms.txt');
    writeFileSync(termsFile, 'zorblax\n');
    const ctx = setup([`Bash | npm failed for ${secret}`, 'Bash | zorblax build failed', 'Bash | plain failure'], { OARS_EXCLUSION_TERMS: termsFile });
    const result = await write(ctx, undefined, false, { OARS_EXCLUSION_TERMS: termsFile });
    const text = read(ctx, AGENTS);
    expect(text).toContain('plain failure');
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/<(user|path|env|host)>/);
    expect(text).not.toMatch(/zorblax/i);
    expect(result.text).toContain('Lines dropped for a name, a secret, an excluded term, or a link: 2.');
  });

  it('drops a line with a link, and every line when all are dropped, writing nothing', async () => {
    const ctx = setup(['Bash | fetch failed for https://example.test/x']);
    const result = await write(ctx);
    expect(result.text).toContain('Every line of the block was dropped, so nothing was written.');
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
    expect(ctx.spool).toEqual([]);
  });

  it('keepLines drops whole lines on a redactor change, a term, or a link', () => {
    const redacts = (line: string): boolean => line.includes('SECRET');
    expect(keepLines(['a', 'b SECRET', 'Zed c', 'd ftp://h/x', 'e'], redacts, ['zed'])).toEqual({ kept: ['a', 'e'], dropped: 3 });
  });

  it('drops a line that holds a branch name the store recorded for the repository, whole and counted, as --receipt would mask it', async () => {
    const ctx = setup(['Bash | fatal: couldn’t find remote ref dev/secret-launch', 'Bash | plain failure']);
    await recordBranch(ctx, 'dev/secret-launch');
    const result = await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text).toContain('plain failure');
    expect(text).not.toContain('dev/secret-launch');
    expect(text).not.toContain('<branch>');
    expect(result.text).toContain('Lines dropped for a name, a secret, an excluded term, or a link: 1.');
  });

  it('drops a line whose next: names a tool the harness tables do not list, and keeps one naming a listed tool', async () => {
    const ctx = setup(['Bash | plain failure']);
    await recordBranch(ctx, 'trunk');
    const index: HookIndex = {
      at: '',
      redactDomains: [],
      signatures: {},
      projects: { [slugOf(ctx.repo)]: [{ ...row('Bash | listed next'), followed: [['Edit', 2]] }, { ...row('Bash | unlisted next'), followed: [['mcp__acme-internal__query', 2]] }] },
    };
    writeFileSync(join(ctx.staged.storeDir, 'hook-index.json'), JSON.stringify(index));
    const result = await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text).toContain('listed next');
    expect(text).not.toContain('unlisted next');
    expect(text).not.toContain('acme-internal');
    expect(result.text).toContain('Lines dropped for a name, a secret, an excluded term, or a link: 1.');
  });

  it('says nothing was written, and names the notice, when nothing recurs in the repository', async () => {
    const ctx = setup([]);
    const result = await write(ctx);
    expect(result.text).toContain('Nothing was written.');
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
    expect(Reflect.get(result.document, 'write')).toBeNull();
  });
});

describe('--write: output', () => {
  it('--dry-run prints the block and the path, and writes nothing', async () => {
    const ctx = setup();
    const result = await write(ctx, undefined, true);
    expect(result.text).toContain(`Would create ${at(ctx, AGENTS)}:`);
    expect(result.text).toContain(BEGIN);
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
    expect(ctx.spool).toEqual([]);
    writeFileSync(at(ctx, AGENTS), 'x\n');
    expect((await write(ctx, undefined, true)).text).toContain(`Would update ${at(ctx, AGENTS)}:`);
    expect(read(ctx, AGENTS)).toBe('x\n');
    await write(ctx);
    expect((await write(ctx, undefined, true)).text).toContain(`These lines are already in ${at(ctx, AGENTS)}:`);
  });

  it('a real write prints the block and the path and says the file is the user’s to commit', async () => {
    const ctx = setup();
    const result = await write(ctx);
    expect(result.text).toContain(at(ctx, AGENTS));
    expect(result.text).toContain(BEGIN);
    expect(result.text).toContain('The file is yours to commit; oars does not run git.');
    expect(Reflect.get(Reflect.get(result.document, 'write'), 'block')).toContain(END);
  });

  it('the written block holds no install, npm, npx, star, or http text, and names manyoars.com once, in the begin marker', async () => {
    const ctx = setup();
    await write(ctx);
    const text = read(ctx, AGENTS);
    expect(text).not.toMatch(/install|npm|npx|star|http/i);
    expect(text.match(/manyoars\.com/g)).toHaveLength(1);
    expect(text.split('\n')[0]).toContain('manyoars.com');
    expect(BEGIN).toBe('<!-- oars recall: begin (written by "oars sessions recall --context --write", manyoars.com; rerun to refresh) -->');
  });
});

describe('--write: telemetry', () => {
  it('leaves one recall-write event with whether the file was created and how many lines, and no content or path', async () => {
    const ctx = setup();
    await write(ctx);
    expect(ctx.spool).toEqual([{ type: 'recall-write', fields: { created: 1, lines: 2 } }]);
    writeFileSync(at(ctx, AGENTS), `${BEGIN}\nold\n${END}\n`);
    await write(ctx);
    expect(ctx.spool.at(-1)).toEqual({ type: 'recall-write', fields: { created: 0, lines: 2 } });
    expect(JSON.stringify(ctx.spool)).not.toContain(ctx.repo);
  });

  it('sends no event when the emitter is absent, as it is under `oars telemetry off`', async () => {
    const ctx = setup();
    await sessionsContextWrite({ ...ctx.sessionDeps, telemetry: undefined }, { cwd: ctx.repo, ...CONTEXT }, { file: undefined, dryRun: false }, {});
    expect(existsSync(at(ctx, AGENTS))).toBe(true);
    expect(ctx.spool).toEqual([]);
  });
});

describe('--write: the command line', () => {
  it('writes through `oars sessions recall --context --write` and prints the result; --json carries the write', async () => {
    const ctx = setup();
    expect(await run(['sessions', 'recall', '--context', '--cwd', ctx.repo, '--write', '--dry-run'], ctx.deps)).toBe(ExitCode.OK);
    expect(ctx.out.join('')).toContain('Dry run: nothing was written.');
    ctx.out.length = 0;
    expect(await run(['--json', 'sessions', 'recall', '--context', '--cwd', ctx.repo, '--write', CLAUDE], ctx.deps)).toBe(ExitCode.OK);
    expect(Reflect.get(Reflect.get(JSON.parse(ctx.out.join('')), 'write'), 'path')).toBe(at(ctx, CLAUDE));
    expect(read(ctx, CLAUDE)).toContain(BEGIN);
  });

  it('refuses --write and --dry-run without their partners', async () => {
    const ctx = setup();
    expect(await run(['sessions', 'recall', '--write'], ctx.deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'recall', '--dry-run'], ctx.deps)).toBe(ExitCode.USAGE);
    expect(await run(['sessions', 'recall', '--context', '--cwd', ctx.repo, '--dry-run'], ctx.deps)).toBe(ExitCode.USAGE);
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
  });

  it('refuses --write and --dry-run beside --counts or --mcp instead of ignoring them', async () => {
    const ctx = setup();
    for (const form of [['--counts', '--write'], ['--mcp', '--write'], ['--counts', '--write', '--dry-run'], ['--mcp', '--write', '--dry-run']]) {
      expect(await run(['sessions', 'recall', '--context', '--cwd', ctx.repo, ...form], ctx.deps)).toBe(ExitCode.USAGE);
    }
    expect(existsSync(at(ctx, AGENTS))).toBe(false);
  });
});
