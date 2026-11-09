// Turns what a working path knows into event fields: counts and closed words only, built here so the path carries one line and the rule for each field is in one place.
// The schema still checks every value; these functions are what make a value fit it (a private model name becomes `other`, not a dropped field).
import type { Recall } from '../sessions/recall-object.js';
import { HARNESSES, OTHER } from '../sessions/pool-wire.js';
import { fileURLToPath } from 'node:url';
import { modelWord, versionWord } from './schema.js';
import type { CiWord, SurfaceWord } from './words.js';

/** The harness every hook oars installs runs under (Claude Code); one spelling for the session hooks and the gate hook, so the two emitters cannot drift. */
export const HOOK_HARNESS = 'claude-code';

/** The harness a hook ran under, as the closed list names it, else `other`. */
export const harnessWord = (harness: string): string => (HARNESSES.some((known) => known === harness) ? harness : OTHER);

/**
 * The harness, harness version, and model a hook saw, as the public vocabulary knows them or `other`; a version or model the hook did not see is absent. A hook fire names its harness (the
 * recall's frame when a push made one); the nightly task runs under none, so its caller passes `undefined` and the event carries no harness (it reads as `unrecorded`).
 */
export const frameWords = (harness: string | undefined, harnessVersion: string | null | undefined, model: string | null | undefined): { harness?: string; harnessVersion?: string; model?: string } => ({
  ...(harness === undefined ? {} : { harness: harnessWord(harness) }),
  ...(harnessVersion === undefined || harnessVersion === null ? {} : { harnessVersion: versionWord(harnessVersion) }),
  ...(model === undefined || model === null ? {} : { model: modelWord(model) }),
});

/** A recall as counts: how it was asked, which families it served, how many reads and evidence rows, the size of the answer, and its arm. Never the query text, a name, or the rendered answer. */
export const recallFields = (recall: Recall, families: readonly string[], legacy = false): object => ({
  form: legacy ? 'legacy' : recall.query.form,
  mode: recall.mode,
  families: [...new Set(families)],
  kind: recall.answer.kind,
  reads: recall.answer.reads.length,
  evidence: recall.evidence.length,
  tokens: recall.answer.tokens,
  arm: recall.arm,
});

/** A provider's own variable and the word it is read as. Order is the precedence: most providers also set `CI`, which on its own reads `other`. */
const CI_PROVIDERS: readonly (readonly [string, CiWord])[] = [
  ['GITHUB_ACTIONS', 'github-actions'],
  ['GITLAB_CI', 'gitlab-ci'],
  ['CIRCLECI', 'circleci'],
  ['TRAVIS', 'travis-ci'],
  ['JENKINS_URL', 'jenkins'],
  ['BUILDKITE', 'buildkite'],
  ['TF_BUILD', 'azure-pipelines'],
  ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
  ['TEAMCITY_VERSION', 'teamcity'],
  ['APPVEYOR', 'appveyor'],
  ['CODEBUILD_BUILD_ID', 'codebuild'],
];

/** A variable counts when it holds anything but the words a shell uses for no (an empty value, `0`, `false`, `no`, `off`). */
const NOT_SET = new Set(['', '0', 'false', 'no', 'off']);
const isSet = (value: string | undefined): boolean => value !== undefined && !NOT_SET.has(value.toLowerCase());

/** Whether this run is in CI, as a closed word read from the environment's variable names. Only the name decides the word: the value is tested and dropped, never returned. */
export const ciWord = (env: NodeJS.ProcessEnv): CiWord => {
  for (const [variable, word] of CI_PROVIDERS) if (isSet(env[variable])) return word;
  return isSet(env.CI) ? 'other' : 'none';
};

/** The harness stores a plugin or extension lands in, matched on the folder names the harness uses under its home. */
const HARNESS_STORES: readonly (readonly [string, SurfaceWord])[] = [
  ['/.claude/plugins/', 'claude-plugin'],
  ['/.codex/plugins/', 'codex-plugin'],
  ['/.gemini/extensions/', 'gemini-extension'],
];

/** Where a package manager keeps a global install: npm and Node's own prefix (`lib/node_modules`, Windows `npm/node_modules`), pnpm, yarn, and bun. */
const GLOBAL_FOLDERS: readonly string[] = ['/lib/node_modules/', '/npm/node_modules/', '/pnpm/global/', '/yarn/global/node_modules/', '/.bun/install/global/'];

/** npm's own folder for a package run once (`npx`), which no other tool uses. */
const NPX_FOLDER = '/_npx/';
/** The folders pnpm (`dlx`) and bun (`bunx-<id>-<package>`) run a package from: names common enough that only a package manager's own agent makes them count. */
const RUNNER_FOLDERS = /\/(dlx|bunx-[^/]*)\//;
const PACKAGE_MANAGER_AGENT = /^(npm|pnpm|yarn|bun)\//;

/**
 * How this copy arrived, as a closed word, from the folder oars runs in and `npm_config_user_agent` and from nothing else. A harness store is read first (a plugin can carry its own
 * `node_modules`), then a package runner, then a global install; a folder that fits none reads `unknown`, never a guess. The agent only confirms a runner: a package manager that started the
 * process says its name there, and a folder called `dlx` with no such agent is not a runner.
 */
export const surfaceWord = (installPath: string, userAgent: string | undefined): SurfaceWord => {
  const path = `/${installPath.split(String.fromCharCode(92)).join('/').toLowerCase()}`;
  const store = HARNESS_STORES.find(([folder]) => path.includes(folder));
  if (store !== undefined) return store[1];
  if (path.includes(NPX_FOLDER)) return 'npx';
  if (RUNNER_FOLDERS.test(path) && userAgent !== undefined && PACKAGE_MANAGER_AGENT.test(userAgent)) return 'npx';
  return GLOBAL_FOLDERS.some((folder) => path.includes(folder)) ? 'npm-global' : 'unknown';
};

/** The folder this module runs from: inside the package wherever it was installed (a symlinked bin resolves to its real folder). */
export const installFolder = (): string => fileURLToPath(import.meta.url);
