import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvMap, SpawnOutcome, SpawnSpec } from './claude-bedrock.js';
import { main } from './preflight.js';
import { serializeRunBook } from './runbook.js';
import { signRunBook } from './sign.js';

const TASKSET_V1 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'taskset', 'v1');
const MARKER = 'bedrock-key-MARKER-9f3a1c';
const COMMIT = '038c12ef29f6237c08f608f089afba2a1b5b12aa';

let root = '';
let taskSet = '';
let fleet = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-preflight-'));
  taskSet = join(root, 'v1');
  cpSync(TASKSET_V1, taskSet, { recursive: true });
  binDir = join(root, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'npm'), '');
  writeFileSync(join(binDir, 'npm.cmd'), '');
  fleet = join(root, 'fleet.json');
  await writeFile(fleet, JSON.stringify({ version: 'fleet-1', harnesses: [{ name: 'claude-code-bedrock', version: '2.1.30', provider: 'bedrock', region: 'us-east-1', modelIds: ['m'] }] }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const outcome = (stdout: string, exitCode: number | null = 0, errorCode: string | null = null, stderr = ''): SpawnOutcome => ({ exitCode, signal: null, stdout, stderr, timedOut: false, errorCode });

interface Tools {
  claude: SpawnOutcome;
  git: SpawnOutcome;
  remote: SpawnOutcome;
}

const GOOD: Tools = {
  claude: outcome('2.1.30 (Claude Code)\n'),
  git: outcome('git version 2.50.0\n'),
  remote: outcome(`${'a'.repeat(40)}\trefs/tags/taskset-v1\n${COMMIT}\trefs/tags/taskset-v1^{}\n`),
};

/** Stands in for the tools by the command's name; records every call, so a test can see that nothing else was started. */
const stubs = (tools: Tools): { spawn: (spec: SpawnSpec) => Promise<SpawnOutcome>; calls: SpawnSpec[] } => {
  const calls: SpawnSpec[] = [];
  return {
    calls,
    spawn: (spec) => {
      calls.push(spec);
      if (spec.command === 'claude') return Promise.resolve(tools.claude);
      return Promise.resolve(spec.args[0] === 'ls-remote' ? tools.remote : tools.git);
    },
  };
};

let binDir = '';
const env = (): EnvMap => ({ AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: MARKER, PATH: binDir });

const run = async (tools: Tools, given?: EnvMap, extra: string[] = [], nodeVersion = '24.1.0'): Promise<{ code: number; lines: string[]; calls: SpawnSpec[] }> => {
  const { spawn, calls } = stubs(tools);
  const lines: string[] = [];
  const code = await main(['--taskset', taskSet, '--fleet', fleet, '--fixture-source', 'https://example.invalid/fixture.git', ...extra], (line) => lines.push(line), { env: given ?? env(), spawn, nodeVersion });
  return { code, lines, calls };
};

const lineOf = (lines: string[], what: string): string => lines.find((line) => line.includes(` ${what}:`)) ?? '';

describe('preflight', () => {
  it('prints ok for every check and exits 0 on a ready machine, starting only the version and ls-remote calls', async () => {
    const { code, lines, calls } = await run(GOOD);
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('ok')).length).toBe(9);
    expect(lines.at(-1)).toBe('preflight: ready');
    expect(calls.map((call) => `${call.command} ${call.args[0] ?? ''}`)).toEqual(['claude --version', 'git --version', 'git ls-remote']);
    expect(calls.every((call) => call.stdin === null)).toBe(true);
    // The children get no Bedrock variable.
    expect(calls.every((call) => !Object.keys(call.env).some((name) => name.startsWith('AWS_')))).toBe(true);
  });

  it('keeps the order: claude, node, git, npm, task set, fixture, region, key, run book', async () => {
    const { lines } = await run(GOOD);
    expect(lines.slice(0, 9).map((line) => /^\w+\s+([^:]+):/.exec(line)?.[1])).toEqual(['claude', 'node', 'git', 'npm', 'task set', 'fixture tag', 'AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK', 'run book']);
  });

  it('says missing when claude does not start', async () => {
    const { code, lines } = await run({ ...GOOD, claude: outcome('', null, 'ENOENT') });
    expect(code).toBe(1);
    expect(lineOf(lines, 'claude')).toMatch(/^missing/);
  });

  it('says wrong when claude is not the pinned version', async () => {
    const { code, lines } = await run({ ...GOOD, claude: outcome('2.1.99 (Claude Code)\n') });
    expect(code).toBe(1);
    expect(lineOf(lines, 'claude')).toMatch(/^wrong .*2\.1\.99.*pinned 2\.1\.30/);
  });

  it('says wrong when Node is below the floor', async () => {
    const { code, lines } = await run(GOOD, undefined, [], '22.4.0');
    expect(code).toBe(1);
    expect(lineOf(lines, 'node')).toMatch(/^wrong .*22.*floor 24/);
  });

  it('compares the Node floor as major.minor.patch and prints it whole', async () => {
    const file = join(taskSet, 'manifest.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('>=24.0.0', '>=24.3.0'));
    const { code, lines } = await run(GOOD, undefined, [], '24.1.0');
    expect(code).toBe(1);
    expect(lineOf(lines, 'node')).toMatch(/^wrong .*24\.1\.0.*floor 24\.3\.0/);
    expect(lineOf((await run(GOOD, undefined, [], '24.3.0')).lines, 'node')).toMatch(/^ok .*24\.3\.0.*floor 24\.3\.0/);
  });

  it('says missing when git or npm does not start', async () => {
    const noGit = await run({ ...GOOD, git: outcome('', null, 'ENOENT') });
    expect(lineOf(noGit.lines, 'git')).toMatch(/^missing/);
    const noNpm = await run(GOOD, { AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: MARKER, PATH: root });
    expect(noNpm.code).toBe(1);
    expect(lineOf(noNpm.lines, 'npm')).toMatch(/^missing/);
  });

  it('says wrong when git starts but exits non-zero', async () => {
    expect(lineOf((await run({ ...GOOD, git: outcome('', 3) })).lines, 'git')).toMatch(/^wrong .*exited 3/);
  });

  it('says wrong with the reason when the task set cannot load, skips only the fixture check, and runs the rest', async () => {
    rmSync(join(taskSet, 'manifest.json'));
    const { code, lines, calls } = await run(GOOD);
    expect(code).toBe(1);
    expect(lineOf(lines, 'task set')).toMatch(/^wrong .*manifest\.json/);
    expect(lines.some((line) => line.includes('fixture'))).toBe(false);
    expect(calls.some((call) => call.args.includes('ls-remote'))).toBe(false);
    expect(lineOf(lines, 'AWS_REGION')).toMatch(/^ok/);
    expect(lineOf(lines, 'run book')).toMatch(/^ok .*none named/);
  });

  it('says wrong and names the file when a task lacks its prompt, check, or setup file', async () => {
    rmSync(join(taskSet, 'prompts', 'control-typo-fix.md'));
    rmSync(join(taskSet, 'checks', 'control-input-check.mjs'));
    rmSync(join(taskSet, 'setup', 'repo-workflow-commit.mjs'));
    const { code, lines } = await run(GOOD);
    expect(code).toBe(1);
    const line = lineOf(lines, 'task set');
    expect(line).toMatch(/^wrong/);
    expect(line).toContain('control-typo-fix.md');
    expect(line).toContain('control-input-check.mjs');
    expect(line).toContain('repo-workflow-commit.mjs');
  });

  it('says missing when the fixture remote does not answer or has no tag', async () => {
    const down = await run({ ...GOOD, remote: outcome('', 128, null, 'fatal: unable to access') });
    expect(down.code).toBe(1);
    expect(lineOf(down.lines, 'fixture remote')).toMatch(/^missing/);
    const none = await run({ ...GOOD, remote: outcome('') });
    expect(lineOf(none.lines, 'fixture remote')).toMatch(/^missing .*no tag taskset-v1/);
  });

  it('says wrong when the tag is not the manifest commit, for a moved annotated and a moved plain tag', async () => {
    const moved = await run({ ...GOOD, remote: outcome(`${'a'.repeat(40)}\trefs/tags/taskset-v1\n${'b'.repeat(40)}\trefs/tags/taskset-v1^{}\n`) });
    expect(moved.code).toBe(1);
    expect(lineOf(moved.lines, 'fixture tag')).toMatch(/^wrong .*moved or the manifest is stale/);
    const plain = await run({ ...GOOD, remote: outcome(`${'c'.repeat(40)}\trefs/tags/taskset-v1\n`) });
    expect(lineOf(plain.lines, 'fixture tag')).toMatch(/^wrong/);
    const same = await run({ ...GOOD, remote: outcome(`${COMMIT}\trefs/tags/taskset-v1\n`) });
    expect(lineOf(same.lines, 'fixture tag')).toMatch(/^ok/);
  });

  it('says missing for an unset region or key', async () => {
    const noRegion = await run(GOOD, { AWS_BEARER_TOKEN_BEDROCK: MARKER });
    expect(noRegion.code).toBe(1);
    expect(lineOf(noRegion.lines, 'AWS_REGION')).toMatch(/^missing/);
    const noKey = await run(GOOD, { AWS_REGION: 'us-east-1' });
    expect(noKey.code).toBe(1);
    expect(lineOf(noKey.lines, 'AWS_BEARER_TOKEN_BEDROCK')).toMatch(/^missing/);
  });

  it('exits 1 with the reason when the fleet manifest or task-set folder cannot be read', async () => {
    const { spawn } = stubs(GOOD);
    const lines: string[] = [];
    const code = await main(['--taskset', taskSet, '--fleet', join(root, 'absent.json'), '--fixture-source', 'x'], (line) => lines.push(line), { env: env(), spawn });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/^preflight: could not finish/);
  });

  it('reads the package fleet manifest when --fleet is absent, and --fleet still wins', async () => {
    const { spawn } = stubs(GOOD);
    const lines: string[] = [];
    await main(['--taskset', taskSet, '--fixture-source', 'x'], (line) => lines.push(line), { env: env(), spawn, defaultFleet: fleet });
    expect(lineOf(lines, 'claude')).toMatch(/^ok /);
    await writeFile(fleet, JSON.stringify({ version: 'fleet-1', harnesses: [] }));
    expect(lineOf((await run(GOOD)).lines, 'claude')).toMatch(/^wrong /);
  });

  it('prefers --fleet over the default in one call, in both directions', async () => {
    const good = join(root, 'good-fleet.json');
    const empty = join(root, 'empty-fleet.json');
    await writeFile(good, await readFile(fleet, 'utf8'));
    await writeFile(empty, JSON.stringify({ version: 'fleet-1', harnesses: [] }));
    const claudeLine = async (flagFile: string, defaultFleet: string): Promise<string> => {
      const { spawn } = stubs(GOOD);
      const lines: string[] = [];
      await main(['--taskset', taskSet, '--fleet', flagFile, '--fixture-source', 'x'], (line) => lines.push(line), { env: env(), spawn, defaultFleet });
      return lineOf(lines, 'claude');
    };
    expect(await claudeLine(good, empty)).toMatch(/^ok /);
    expect(await claudeLine(empty, good)).toMatch(/^wrong /);
  });

  it('says wrong when the fleet manifest names no claude-code-bedrock harness', async () => {
    await writeFile(fleet, JSON.stringify({ version: 'fleet-1', harnesses: [] }));
    const { code, lines } = await run(GOOD);
    expect(code).toBe(1);
    expect(lineOf(lines, 'claude')).toMatch(/^wrong .*no claude-code-bedrock/);
  });

  it('exits 2 with the usage line without the required flags', async () => {
    const lines: string[] = [];
    expect(await main(['--taskset', taskSet], (line) => lines.push(line), { env: env() })).toBe(2);
    expect(lines[0]).toMatch(/^usage: preflight/);
    expect(await main(['--taskset', taskSet, '--fleet', fleet, '--fixture-source', 'x', '--run-book', 'b'], (line) => lines.push(line), { env: env() })).toBe(2);
  });

  it('verifies a named run book: wrong without a signature, ok with one', async () => {
    const book = join(root, 'o-1.run-book.jsonl');
    const header = { orderId: 'o-1', line: 'retest', taskSetVersion: 'v1', manifestVersion: 'fleet-1', fixtureTag: 't', fixtureCommit: 'c', tools: [], arms: [], sides: [], operator: 'Many Oars Co.', account: 'a', repeats: 1, runCap: 1, startDate: '2026-11-16', endDate: '2026-11-16', status: 'complete' as const, shortCells: [] };
    await writeFile(book, serializeRunBook({ header, runs: [] }));
    const key = join(root, 'key');
    const made = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'run-book@manyoars.com', '-f', key], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`ssh-keygen is required: ${made.stderr}`);
    const [type, material] = (await readFile(`${key}.pub`, 'utf8')).trim().split(' ');
    const allowed = join(root, 'allowed_signers');
    await writeFile(allowed, `run-book@manyoars.com namespaces="manyoars-runbook" ${type ?? ''} ${material ?? ''}\n`);
    const unsigned = await run(GOOD, undefined, ['--run-book', book, '--allowed-signers', allowed]);
    expect(unsigned.code).toBe(1);
    expect(lineOf(unsigned.lines, 'run book')).toMatch(/^wrong/);
    await signRunBook(book, key);
    const signed = await run(GOOD, undefined, ['--run-book', book, '--allowed-signers', allowed]);
    expect(signed.code).toBe(0);
    expect(lineOf(signed.lines, 'run book')).toMatch(/^ok .*verifies/);
  });
});

describe('preflight and the key', () => {
  it('never prints the key value, even when a tool echoes it or an error carries it', async () => {
    const leaky = outcome(`2.1.30 ${MARKER}`, 0, null, `token ${MARKER}`);
    const everything: string[] = [];
    const echoing = await run({ ...GOOD, claude: leaky, remote: outcome('', 128, null, `fatal: ${MARKER}`) });
    everything.push(...echoing.lines);
    // An error that carries the value: a fleet file whose name contains it.
    const lines: string[] = [];
    const { spawn } = stubs(GOOD);
    await main(['--taskset', taskSet, '--fleet', join(root, `${MARKER}.json`), '--fixture-source', 'x'], (line) => lines.push(line), { env: env(), spawn });
    everything.push(...lines);
    expect(everything.length).toBeGreaterThan(5);
    expect(everything.join('\n')).not.toContain(MARKER);
    expect(everything.join('\n')).toContain('[key removed]');
  });
});
