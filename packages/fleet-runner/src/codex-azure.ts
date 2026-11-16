// The second real harness adapter: Codex CLI on Azure OpenAI, headless (`codex exec`), on an Azure API key (spec sections 3, 4, and 9). The reset, tool install, check, transcript copy,
// and cleanup are `harness-shared.ts`; this file holds only what is Codex's own: the fresh `CODEX_HOME` and its `config.toml`, the command line, the environment, and reading the rollout file.
// Docs (read 2026-11-16):
//   headless mode, `--json` events, `exec -` stdin prompt   https://developers.openai.com/codex/noninteractive
//   flags (`--sandbox`, `--model`, `--cd`, `--ignore-rules`, `-c`)   https://developers.openai.com/codex/cli/reference
//   `config.toml` keys (`model_providers.<id>.base_url`, `.env_key`, `.query_params`, `.wire_api`, `mcp_servers.<id>.*`, `approval_policy`, `sandbox_mode`, `web_search`, `skills.bundled.enabled`,
//   `check_for_update_on_startup`, `analytics.enabled`, `feedback.enabled`)   https://developers.openai.com/codex/config-reference
//   the shell environment policy (`inherit`, `ignore_default_excludes`, `filters`), `CODEX_HOME`   https://developers.openai.com/codex/config-advanced
//   skills (`$HOME/.agents/skills`)   https://developers.openai.com/codex/skills
//   rollout file `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` under `CODEX_HOME`, its `session_meta.cli_version`, `turn_context.model`, and `token_count` events: the oars reader,
//   `packages/cli/src/sessions/codex.ts` (header comment, and `usageOf` for the token rule), which cites codex-rs at ac558e2.
// The Azure provider follows the docs' own example (config-advanced, "Azure provider and per-provider tuning"): `base_url = "https://YOUR_PROJECT_NAME.openai.azure.com/openai"`, `env_key = "AZURE_OPENAI_API_KEY"`,
// `query_params = { api-version = "2025-04-01-preview" }`, `wire_api = "responses"`. `azureEndpoint` and `apiVersion` are the operator's; the `api-version` query parameter is written only when one is set.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CheckResult, ExitKind, HarnessAdapter, Prepared, RunRequest, RunResult, TokenCounts } from './harness.js';
import { assertStarted, copySkill, loadCheckedResetPlan, makeFolders, makeSteps, nodeSpawn, pick, START_NAMES, type Dependencies, type Layout, type PreparedFolder, type SharedSettings, type SpawnOutcome } from './harness-shared.js';
import { isObject, type JsonObject } from './json.js';

export interface CodexAzureSettings extends SharedSettings {
  codexExecutable: string;
  /** Arguments placed before Codex's own (empty for the real native executable; for an npm install, `[<global node_modules>/@openai/codex/bin/codex.js]` with `node` as the executable). */
  codexArgs: string[];
  /** The Azure OpenAI base URL, in the docs' example's shape `https://<resource>.openai.azure.com/openai` (config-advanced, per-provider tuning). */
  azureEndpoint: string;
  /** The Azure deployment name; Codex sends it as the model. */
  deployment: string;
  /** Added as the `api-version` query parameter, as the docs' example does (`2025-04-01-preview`); null for none. */
  apiVersion: string | null;
}

export type CodexPrepared = PreparedFolder;

/** The environment variable the Azure key is read from, in the caller's environment and in `codex`'s. */
export const AZURE_KEY_NAME = 'AZURE_OPENAI_API_KEY';

const toml = (value: string): string => JSON.stringify(value);

/** The fresh `CODEX_HOME/config.toml`: the Azure provider, no sign-in, nothing from the caller's own Codex home, and at most the one tool under test. */
export const configToml = (settings: CodexAzureSettings, tool: { name: string; command: string; args: string[] } | null): string => {
  const lines = [
    `model = ${toml(settings.deployment)}`,
    'model_provider = "azure"',
    // No person is there to approve a command or a tool call; the sandbox is the limit. `web_search` off so no run reads the web.
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.azure]',
    'name = "Azure OpenAI"',
    `base_url = ${toml(settings.azureEndpoint)}`,
    `env_key = ${toml(AZURE_KEY_NAME)}`,
    'wire_api = "responses"',
    ...(settings.apiVersion === null ? [] : [`query_params = { api-version = ${toml(settings.apiVersion)} }`]),
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[skills.bundled]',
    'enabled = false',
    '',
    // The agent's shell commands start from a trimmed environment with every name holding KEY, SECRET, or TOKEN removed, and everything named AZURE_ removed.
    '[shell_environment_policy]',
    'inherit = "core"',
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.filters]',
    '"AZURE_*" = "exclude"',
  ];
  if (tool !== null) {
    // No `env` or `env_vars`: Codex starts the server with its default environment only, so the key is not named to it.
    lines.push('', `[mcp_servers.${toml(tool.name)}]`, `command = ${toml(tool.command)}`, `args = ${JSON.stringify(tool.args)}`, 'default_tools_approval_mode = "approve"');
  }
  return `${lines.join('\n')}\n`;
};

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

interface RolloutFacts {
  version: string | null;
  model: string | null;
  tokens: TokenCounts;
}

/** What the rollout says: `session_meta.cli_version`, the first `turn_context.model`, and `event_msg token_count` `info.last_token_usage` summed, with Codex's cached and cache-write tokens (counted inside `input_tokens`) moved to `cache`, as the oars reader does. */
export const parseRollout = (text: string): RolloutFacts => {
  const facts: RolloutFacts = { version: null, model: null, tokens: { input: 0, cache: 0, output: 0 } };
  let inherited: number | null = null;
  for (const raw of text.split('\n')) {
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(row) || !isObject(row['payload'])) continue;
    const payload = row['payload'];
    // A spawned agent's rollout starts with its parent's records, below `subagent_history_start_ordinal` (the oars reader drops them, `packages/cli/src/sessions/codex.ts:555-556`).
    if (typeof row['ordinal'] === 'number' && inherited !== null && row['ordinal'] < inherited) continue;
    if (row['type'] === 'session_meta' && facts.version === null) {
      facts.version = typeof payload['cli_version'] === 'string' ? payload['cli_version'] : null;
      inherited = typeof payload['subagent_history_start_ordinal'] === 'number' ? payload['subagent_history_start_ordinal'] : null;
    } else if (row['type'] === 'turn_context' && facts.model === null) {
      facts.model = typeof payload['model'] === 'string' ? payload['model'] : null;
    } else if (row['type'] === 'event_msg' && payload['type'] === 'token_count' && isObject(payload['info']) && isObject(payload['info']['last_token_usage'])) {
      const usage = payload['info']['last_token_usage'];
      const input = num(usage['input_tokens']);
      const cached = Math.min(num(usage['cached_input_tokens']), input);
      const written = Math.min(num(usage['cache_write_input_tokens']), input - cached);
      facts.tokens.input += input - cached - written;
      facts.tokens.cache += cached + written;
      facts.tokens.output += num(usage['output_tokens']);
    }
  }
  return facts;
};

interface EventFacts {
  completed: boolean;
  /** The last `turn.failed` or `error` message, or null. */
  failure: string | null;
}

/** Reads `--json` stdout: `turn.completed`, and the message of `turn.failed` or `error` (https://developers.openai.com/codex/noninteractive#create-structured-outputs-with-a-schema lists the event types). */
export const parseEvents = (stdout: string): EventFacts => {
  const facts: EventFacts = { completed: false, failure: null };
  for (const raw of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event['type'] === 'turn.completed') facts.completed = true;
    else if (event['type'] === 'turn.failed' && isObject(event['error']) && typeof event['error']['message'] === 'string') facts.failure = event['error']['message'];
    else if (event['type'] === 'error' && typeof event['message'] === 'string') facts.failure = event['message'];
  }
  return facts;
};

const RATE_TEXT = /\b429\b|rate.?limit|too many requests/i;
const AUTH_TEXT = /\b(401|403)\b|incorrect api key|invalid api key|access denied|unauthorized|permissiondenied/i;
const NETWORK_TEXT = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/;

const classify = (outcome: SpawnOutcome, facts: EventFacts): ExitKind => {
  if (outcome.errorCode === 'ENOSPC') return 'disk-full';
  if (outcome.timedOut) return 'crash';
  if (outcome.exitCode === 0 && facts.completed && facts.failure === null) return 'ok';
  const text = facts.failure ?? `${outcome.stderr}\n${outcome.stdout}`;
  if (RATE_TEXT.test(text)) return 'rate-limit';
  if (AUTH_TEXT.test(text)) return 'auth-rejected';
  if (NETWORK_TEXT.test(text)) return 'network-down';
  return facts.failure === null ? 'crash' : 'api-error';
};

const NEWLINE = '\n';

interface Rollouts {
  /** The run's own rollout: the last by name that no spawned agent or delegate wrote. */
  own: string | null;
  /** The rollouts of spawned agents and delegates, whose tokens count toward the run. */
  others: string[];
}

/** Whether a rollout's first record marks a non-root one, as the oars reader's `parentOf` does (`packages/cli/src/sessions/codex.ts:715-727`): a `parent_thread_id`, or a `source` object holding `subagent` or `internal`. */
const isNonRoot = (meta: JsonObject): boolean => {
  if (meta['parent_thread_id'] !== undefined && meta['parent_thread_id'] !== null) return true;
  const source = meta['source'];
  return isObject(source) && (Object.hasOwn(source, 'subagent') || Object.hasOwn(source, 'internal'));
};

/** The rollouts under `<codexHome>/sessions`, split into the run's own and the rest. Null own when Codex wrote none. */
const findRollouts = async (codexHome: string): Promise<Rollouts> => {
  const names = await readdir(join(codexHome, 'sessions'), { recursive: true, encoding: 'utf8' }).catch(() => []);
  const own: string[] = [];
  const others: string[] = [];
  for (const name of names.filter((entry) => /(^|[\\/])rollout-[^\\/]+\.jsonl$/.test(entry)).sort()) {
    const path = join(codexHome, 'sessions', name);
    const first = (await readFile(path, 'utf8')).split(NEWLINE)[0] ?? '';
    let head: unknown = null;
    try {
      head = JSON.parse(first);
    } catch {
      // A torn first line: the file is taken as the run's own.
    }
    const meta: JsonObject | null = isObject(head) && isObject(head['payload']) ? head['payload'] : null;
    (meta !== null && isNonRoot(meta) ? others : own).push(path);
  }
  return { own: own.at(-1) ?? null, others };
};

/** The adapter, with `prepare` typed to return the richer folder so a caller can read its commit and paths. */
export interface CodexAzureAdapter extends Omit<HarnessAdapter, 'prepare'> {
  prepare: (request: RunRequest) => Promise<CodexPrepared>;
}

export const makeCodexAzure = (settings: CodexAzureSettings, deps: Dependencies): CodexAzureAdapter => {
  const key = deps.env[AZURE_KEY_NAME];
  if (key === undefined || key === '') throw new Error(`${AZURE_KEY_NAME} is not set: the fleet runs on an Azure API key and never falls back to a ChatGPT sign-in`);
  if (settings.azureEndpoint === '') throw new Error('the Azure endpoint setting is empty: Codex needs a base URL');
  if (settings.deployment === '') throw new Error('the Azure deployment setting is empty: it is the model name Codex sends');
  if (['.cmd', '.bat'].includes(extname(settings.codexExecutable).toLowerCase())) throw new Error(`${settings.codexExecutable} is a batch wrapper: a timeout would kill the wrapper and leave codex running. Use the native codex executable, or node with the package's bin/codex.js through codexArgs`);
  const reset = loadCheckedResetPlan(settings, deps.nodeVersion);
  const spawn = deps.spawn ?? nodeSpawn;
  const steps = makeSteps(settings, deps, spawn);
  const { remember, folderOf } = makeFolders();

  // A server is given to Codex through the one `[mcp_servers.<name>]` table in `config.toml`; a skill is copied to `$HOME/.agents/skills/<name>`, the user location the docs name, and HOME is the run's own folder.
  const layout: Layout = {
    tempPrefix: 'fleet-codex-',
    configName: 'codex-home',
    wire: async (installing, root, configDir) => {
      let server: { name: string; command: string; args: string[] } | null = null;
      if (installing?.tool.kind === 'server') {
        const entry = await steps.installServer(installing.tool, installing.wanted, root, configDir);
        server = { name: installing.tool.name, command: 'node', args: [entry, ...installing.tool.args] };
      } else if (installing !== null) {
        await copySkill(await steps.checkoutSkill(installing.tool, installing.wanted, root), join(root, 'home', '.agents', 'skills', installing.tool.name));
      }
      await writeFile(join(configDir, 'config.toml'), configToml(settings, server));
    },
  };

  const prepare = async (request: RunRequest): Promise<CodexPrepared> => {
    const made = await steps.prepareRun(request, layout, reset);
    remember(made);
    return made;
  };

  const run = async (prepared: Prepared, request: RunRequest): Promise<RunResult> => {
    const folder = folderOf(prepared);
    const skipped = await steps.recheckPins(folder, request);
    if (skipped !== null) return skipped;
    const prompt = await readFile(join(settings.taskSetDir, 'prompts', `${request.taskId}.md`), 'utf8');
    const args = [
      ...settings.codexArgs,
      'exec',
      '--json',
      '--sandbox', 'workspace-write',
      '--model', settings.deployment,
      '--cd', folder.runFolder,
      '--ignore-rules',
      // `-` makes stdin the whole prompt (noninteractive#when-stdin-is-the-prompt).
      '-',
    ];
    const env = {
      ...pick(deps.env, START_NAMES),
      HOME: join(folder.dir, 'home'),
      USERPROFILE: join(folder.dir, 'home'),
      CODEX_HOME: folder.configDir,
      [AZURE_KEY_NAME]: key,
    };
    const outcome = await spawn({ command: settings.codexExecutable, args, cwd: folder.runFolder, env, stdin: prompt, timeoutMs: settings.timeLimitMs });
    assertStarted(outcome, settings.codexExecutable);
    const kind = classify(outcome, parseEvents(outcome.stdout));
    const { own: rollout, others } = await findRollouts(folder.configDir);
    const facts = rollout === null ? null : parseRollout(await readFile(rollout, 'utf8'));
    // Like the Claude adapter's, the tokens cover the whole tree: the spawned agents' rollouts add theirs.
    if (facts !== null) {
      for (const other of others) {
        const spent = parseRollout(await readFile(other, 'utf8')).tokens;
        facts.tokens.input += spent.input;
        facts.tokens.cache += spent.cache;
        facts.tokens.output += spent.output;
      }
    }
    return {
      exit: { kind, code: outcome.timedOut ? -1 : (outcome.exitCode ?? -1) },
      transcriptPath: rollout === null ? null : await steps.copyTranscript(rollout, request.runId),
      harnessVersion: facts?.version ?? 'unknown',
      modelId: facts?.model ?? 'unknown',
      tokens: facts?.tokens ?? { input: 0, cache: 0, output: 0 },
      poolSessionId: null,
    };
  };

  const check = (prepared: Prepared, request: RunRequest): Promise<CheckResult> => steps.runCheck(folderOf(prepared), request);

  return { prepare, run, check };
};
