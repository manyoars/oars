// The real harness adapter: Claude Code on Amazon Bedrock, headless (`claude -p`), on a Bedrock API key (spec sections 3, 4, and 9). `prepare` does the section 3 reset in a
// new temp folder, `run` starts `claude` there with only the variables named below, `check` runs the task's check script. Docs (read 2026-11-16):
//   headless and flags   https://code.claude.com/docs/en/headless.md , https://code.claude.com/docs/en/cli-reference.md
//   Bedrock variables    https://code.claude.com/docs/en/amazon-bedrock.md , https://code.claude.com/docs/en/env-vars.md
//   transcript location  https://code.claude.com/docs/en/sessions.md#where-transcripts-are-stored
//   stream-json result   https://code.claude.com/docs/en/agent-sdk/typescript.md (SDKSystemMessage, SDKResultMessage, ModelUsage)
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { CheckResult, ExitKind, HarnessAdapter, Prepared, RunRequest, RunResult, TokenCounts } from './harness.js';
import { assertStarted, copySkill, loadCheckedResetPlan, makeFolders, makeSteps, nodeSpawn, pick, START_NAMES, toolFor, type Dependencies, type Layout, type PreparedFolder, type SharedSettings, type SpawnOutcome } from './harness-shared.js';
import { isObject } from './json.js';

// The shared types stay importable from here, where the adapter's callers and tests have always found them.
export { loadResetPlan, makeNodeSpawn, nodeSpawn } from './harness-shared.js';
export type { ChildEnv, CommandSpec, Dependencies, EnvMap, HostProcess, ResetPlan, ServerTool, SkillTool, Spawn, SpawnOutcome, SpawnSpec, StartTimer, ToolUnderTest } from './harness-shared.js';

export interface ClaudeBedrockSettings extends SharedSettings {
  claudeExecutable: string;
  /** Arguments placed before Claude Code's own (empty for the real executable). */
  claudeArgs: string[];
  awsRegion: string;
  modelId: string;
  allowedTools: string[];
}

export type ClaudePrepared = PreparedFolder;

const AUTH_TEXT = /\b(401|403)\b|invalid (api key|token|security token)|not authorized|security token.*(invalid|expired)|unrecognizedclient/i;
const NETWORK_TEXT = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENETUNREACH/;

interface StreamFacts {
  version: string | null;
  model: string | null;
  result: { isError: boolean; status: number | null } | null;
  tokens: TokenCounts;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Reads stream-json lines: the `system/init` event (version, model) and the final `result` event (error state, per-model usage summed over the whole tree). */
export const parseStream = (stdout: string): StreamFacts => {
  const facts: StreamFacts = { version: null, model: null, result: null, tokens: { input: 0, cache: 0, output: 0 } };
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event['type'] === 'system' && event['subtype'] === 'init') {
      const version = event['claude_code_version'];
      const model = event['model'];
      facts.version = typeof version === 'string' ? version : null;
      facts.model = typeof model === 'string' ? model : null;
    } else if (event['type'] === 'result') {
      const status = event['api_error_status'];
      facts.result = { isError: event['is_error'] === true, status: typeof status === 'number' ? status : null };
      const usageByModel = event['modelUsage'];
      if (isObject(usageByModel)) {
        for (const usage of Object.values(usageByModel)) {
          if (!isObject(usage)) continue;
          facts.tokens.input += num(usage['inputTokens']);
          facts.tokens.cache += num(usage['cacheReadInputTokens']) + num(usage['cacheCreationInputTokens']);
          facts.tokens.output += num(usage['outputTokens']);
        }
      }
    }
  }
  return facts;
};

const classify = (outcome: SpawnOutcome, facts: StreamFacts): ExitKind => {
  if (outcome.errorCode === 'ENOSPC') return 'disk-full';
  if (outcome.timedOut) return 'crash';
  if (facts.result !== null) {
    if (!facts.result.isError) return 'ok';
    if (facts.result.status === 401 || facts.result.status === 403) return 'auth-rejected';
    if (facts.result.status === 429) return 'rate-limit';
    return facts.result.status === null ? 'crash' : 'api-error';
  }
  const text = `${outcome.stderr}\n${outcome.stdout}`;
  if (AUTH_TEXT.test(text)) return 'auth-rejected';
  if (NETWORK_TEXT.test(text)) return 'network-down';
  return 'crash';
};

/** The adapter, with `prepare` typed to return the richer folder so a caller can read its commit and paths. */
export interface ClaudeBedrockAdapter extends Omit<HarnessAdapter, 'prepare'> {
  prepare: (request: RunRequest) => Promise<ClaudePrepared>;
}

export const makeClaudeBedrock = (settings: ClaudeBedrockSettings, deps: Dependencies): ClaudeBedrockAdapter => {
  const key = deps.env['AWS_BEARER_TOKEN_BEDROCK'];
  if (key === undefined || key === '') throw new Error('AWS_BEARER_TOKEN_BEDROCK is not set: the fleet runs on a Bedrock API key and never falls back to a personal Claude sign-in');
  if (settings.awsRegion === '') throw new Error('the AWS region setting is empty: Bedrock needs a region');
  if (settings.modelId === '') throw new Error('the model ID setting is empty');
  if (['.cmd', '.bat'].includes(extname(settings.claudeExecutable).toLowerCase())) throw new Error(`${settings.claudeExecutable} is a batch wrapper: a timeout would kill the wrapper and leave claude running. Use the native claude executable, or node with cli.js through claudeArgs`);
  const reset = loadCheckedResetPlan(settings, deps.nodeVersion);
  const spawn = deps.spawn ?? nodeSpawn;
  const steps = makeSteps(settings, deps, spawn);
  const { remember, folderOf } = makeFolders();

  // A server is given to Claude Code through `mcp.json` and a skill is copied to `<config>/skills/<name>`.
  const layout: Layout = {
    tempPrefix: 'fleet-claude-',
    configName: 'config',
    wire: async (installing, root, configDir) => {
      if (installing === null) return;
      const { tool, wanted } = installing;
      if (tool.kind === 'server') {
        const entry = await steps.installServer(tool, wanted, root, configDir);
        await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { [tool.name]: { command: 'node', args: [entry, ...tool.args] } } }));
        return;
      }
      await copySkill(await steps.checkoutSkill(tool, wanted, root), join(configDir, 'skills', tool.name));
    },
  };

  const prepare = async (request: RunRequest): Promise<ClaudePrepared> => {
    const made = await steps.prepareRun(request, layout, reset);
    remember(made);
    return made;
  };

  const run = async (prepared: Prepared, request: RunRequest): Promise<RunResult> => {
    const folder = folderOf(prepared);
    const skipped = await steps.recheckPins(folder, request);
    if (skipped !== null) return skipped;
    const tool = toolFor(settings, request.arm);
    const prompt = await readFile(join(settings.taskSetDir, 'prompts', `${request.taskId}.md`), 'utf8');
    const sessionId = randomUUID();
    const allowed = [...settings.allowedTools, ...(tool?.kind === 'server' ? [`mcp__${tool.name}`] : [])];
    const mcpFile = join(folder.configDir, 'mcp.json');
    if (tool?.kind !== 'server') await writeFile(mcpFile, JSON.stringify({ mcpServers: {} }));
    const args = [
      ...settings.claudeArgs,
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
      '--model', settings.modelId,
      '--strict-mcp-config',
      '--mcp-config', mcpFile,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allowed.join(','),
    ];
    const env = {
      ...pick(deps.env, START_NAMES),
      HOME: join(folder.dir, 'home'),
      USERPROFILE: join(folder.dir, 'home'),
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: settings.awsRegion,
      AWS_BEARER_TOKEN_BEDROCK: key,
      ANTHROPIC_MODEL: settings.modelId,
      // Pinned so background work (which runs on the haiku alias) uses the run's own model and no unpinned model draws credit: env-vars.md and model-config.md#environment-variables.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.modelId,
      // Strips the Bedrock key from the agent's Bash, hooks, and the tool's stdio MCP server (env-vars.md, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB); Claude Code keeps it for its own API calls.
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CONFIG_DIR: folder.configDir,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'work',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const outcome = await spawn({ command: settings.claudeExecutable, args, cwd: folder.runFolder, env, stdin: prompt, timeoutMs: settings.timeLimitMs });
    assertStarted(outcome, settings.claudeExecutable);
    const facts = parseStream(outcome.stdout);
    const kind = classify(outcome, facts);
    const transcriptPath = await steps.copyTranscript(join(folder.configDir, 'projects', 'work', `${sessionId}.jsonl`), request.runId);
    return {
      exit: { kind, code: outcome.timedOut ? -1 : (outcome.exitCode ?? -1) },
      transcriptPath,
      harnessVersion: facts.version ?? 'unknown',
      modelId: facts.model ?? 'unknown',
      tokens: facts.tokens,
      poolSessionId: null,
    };
  };

  const check = (prepared: Prepared, request: RunRequest): Promise<CheckResult> => steps.runCheck(folderOf(prepared), request);

  return { prepare, run, check };
};
