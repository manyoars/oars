// The Bedrock adapter's whole reset, setup, run, and check path over the REAL committed task set (`taskset/v1/`), against a stand-in fixture: a temp git repository tagged
// `taskset-v1` that holds just enough for the two setup scripts. The real fixture is a private repository and is not in oars. The stub `claude` and a stub `npm` stand in for the
// rest, so no key, network, or spend is involved. A check failing on the stand-in is expected; the proof is that it is called with the run folder and its exit is handled.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClaudeBedrock, nodeSpawn, type ClaudeBedrockSettings, type Spawn, type SpawnOutcome, type SpawnSpec } from './claude-bedrock.js';
import type { RunRequest } from './harness.js';
import { parseOrder } from './order.js';
import { comparisonText, FLEET } from './test-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKSET = join(HERE, '..', '..', '..', 'taskset', 'v1');
const STUB = join(HERE, 'stub-claude.mjs');
const MODEL = 'sonnet-pinned-1';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

// What the two setup scripts edit (their `swap` calls need these exact lines); nothing here is run.
const STAND_IN: { [path: string]: string } = {
  // As the real fixture has: the setup scripts match LF text, and a Windows clone would otherwise check out CRLF.
  '.gitattributes': '* text=auto eol=lf\n',
  'scripts/build-db.ts': "import { writeFileSync } from 'node:fs';\nwriteFileSync('app.db', 'built');\n",
  'src/lib/validate.ts': "export const MAX_QUANTITY = 999;\nexport const note = (note) => {\n  const trimmed = typeof note === 'string' ? note.trim() : '';\n  return trimmed;\n};\n",
  'test/lib.test.ts': "import { parseNewRequest, parseQuantity } from '../src/lib/validate.ts';\n",
  'docs/faq.md': '# FAQ\n',
  'src/queries.ts': 'export const recentRequests = 1;\n',
  'src/app.ts': "import { recentRequests, requestsForMember, statusSummary } from './queries.ts';\nexport const route = (path) => {\n  if (path === '/api/requests') {\n    return 1;\n  }\n};\n",
};

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'bedrock-taskset-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const standInFixture = (): string => {
  const dir = join(scratch, 'fixture');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [path, text] of Object.entries(STAND_IN)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'tag', 'taskset-v1');
  return dir;
};

interface Call {
  command: string;
  args: string[];
  cwd: string;
  outcome: SpawnOutcome;
}

/** Real spawn for everything, the `npm ci` of the manifest's reset excepted (no network), and a record of every call. */
const recording = (calls: Call[]): Spawn => async (spec: SpawnSpec) => {
  const outcome: SpawnOutcome = spec.command === 'npm-stub' ? { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, errorCode: null } : await nodeSpawn(spec);
  calls.push({ command: spec.command, args: spec.args, cwd: spec.cwd, outcome });
  return outcome;
};

const request = (taskId: string, category: string): RunRequest => ({
  runId: `o-2-${taskId}`,
  sequence: 1,
  attempt: 1,
  order: parseOrder(comparisonText(), FLEET),
  taskId,
  category,
  arm: 'no-tool',
  side: null,
  repeat: 1,
  expected: { taskSetVersion: 'v1', fixtureTag: 'taskset-v1', manifestVersion: 'fleet-1', harnessVersion: '2.1.30', modelId: MODEL, toolPins: [] },
});

const settings = (fixture: string): ClaudeBedrockSettings => ({
  fixtureSource: fixture,
  fixtureTag: 'taskset-v1',
  taskSetDir: TASKSET,
  fleetManifestVersion: 'fleet-1',
  claudeExecutable: process.execPath,
  claudeArgs: [STUB],
  awsRegion: 'us-east-1',
  modelId: MODEL,
  tool: null,
  timeLimitMs: 20000,
  setupTimeLimitMs: 120000,
  transcriptOutDir: join(scratch, 'transcripts'),
  gitExecutable: 'git',
  npmExecutable: 'npm-stub',
  allowedTools: ['Bash', 'Read', 'Edit', 'Write'],
  setupEnvNames: [],
});

const ENV = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-not-real-0001' };

describe('the adapter over taskset/v1 and a stand-in fixture', () => {
  it.each([
    ['control-typo-fix', 'control', null],
    ['control-input-check', 'control', null],
    ['repo-workflow-commit', 'repo-workflow', 'v1-base'],
    ['repo-workflow-review', 'repo-workflow', 'v1-review-files'],
  ])('%s: resets, runs its setup if it has one, sends the real prompt, and calls the real check with the run folder', async (taskId, category, marker) => {
    const calls: Call[] = [];
    const adapter = makeClaudeBedrock(settings(standInFixture()), { env: ENV, spawn: recording(calls) });
    const req = request(taskId, category);
    const prepared = await adapter.prepare(req);
    try {
      // The reset: the manifest's install (stubbed, no network) and database build, in the clone.
      expect(calls.find((call) => call.command === 'npm-stub')?.args).toEqual(['ci', '--no-audit', '--no-fund']);
      expect(readFileSync(join(prepared.runFolder, 'app.db'), 'utf8')).toBe('built');
      // The setup script named by the manifest ran for the two setup tasks only, with the run folder as its argument.
      const setupCalls = calls.filter((call) => call.args[0]?.includes(`${join('taskset', 'v1', 'setup')}`) ?? false);
      expect(setupCalls.map((call) => [basename(call.args[0] ?? ''), call.args[1]])).toEqual(marker === null ? [] : [[`${taskId}.mjs`, prepared.runFolder]]);
      for (const name of ['v1-base', 'v1-review-files']) expect(existsSync(join(prepared.runFolder, '.git', name)), name).toBe(name === marker);
      // The stand-in's commit is not the manifest's, so the adapter reports the tag as moved (the runner voids that); the real fixture matches.
      expect(prepared.fixtureTag).toMatch(/^taskset-v1@[0-9a-f]{40}$/);

      const result = await adapter.run(prepared, req);
      expect(result.exit).toEqual({ kind: 'ok', code: 0 });
      const stubSeen: unknown = JSON.parse(readFileSync(join(prepared.configDir, 'stub-seen.json'), 'utf8'));
      expect(stubSeen).toMatchObject({ prompt: readFileSync(join(TASKSET, 'prompts', `${taskId}.md`), 'utf8') });

      // The check: the real script, called with the run folder, its exit handled (a fail on the stand-in).
      expect(await adapter.check(prepared, req)).toBe('fail');
      const check = calls.at(-1);
      expect(check?.command).toBe(process.execPath);
      expect(check?.args).toEqual([join(TASKSET, 'checks', `${taskId}.mjs`), prepared.runFolder]);
      expect(check?.cwd).toBe(prepared.runFolder);
      expect(check?.outcome.exitCode).toBe(1);
      expect(check?.outcome.stdout.trim().split('\n').at(-1)).not.toBe('');
    } finally {
      await prepared.dispose();
    }
    expect(existsSync(prepared.dir)).toBe(false);
  });
});
