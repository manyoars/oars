// The hook dialects: what a harness's hook payload looks like on the way in and what its answer looks like on the way out. One small seam, so a harness that is not Claude Code
// is a table row here and not a branch in the hooks: `readPayload` turns the harness's payload into the Claude-shaped input the handlers read (`session_id`, `cwd`, `tool_name`,
// `tool_input`, `error`, `model`, `transcript_path`), and `answer` turns the text a handler wants the model to see into the harness's own reply.
//
// The dialect is named by the hook command (`oars-hook session-start --harness copilot`), not guessed from the payload. A payload's casing says only how the harness spelled that
// one event (Copilot sends snake_case for a PascalCase registration and camelCase for a camelCase one, and `userPromptTransformed` is camelCase only), so a guess from the
// casing would read the same payload two ways; the manifest that registers the command is the one place that knows which harness will run it.
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_TOOLS, type CanonicalAction } from './actions.js';
import { callFailureOf } from './codex-rollout.js';
import { ARCHIVE, copilotRoot, SAFE_ID } from './copilot.js';
import type { Harness } from './schema.js';

type Input = { [key: string]: unknown };

const isRecord = (value: unknown): value is Input => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export interface Dialect {
  /** The harness this dialect speaks for: the action table, the recall's frame, and the hook-call telemetry name it. */
  harness: Harness;
  /** The payload as the Claude-shaped input the handlers read; a key the dialect does not know is left as it came. */
  readPayload: (payload: Input) => Input;
  /** The reply for what a handler wants the model to see, or undefined when this harness has no way to carry it for that event (the hook then prints nothing). */
  answer: (event: string, context: string, payload: Input) => string | undefined;
  /** The harness version for a session when the payload does not carry it, or null when it cannot be read. Claude Code has none: its version is in the transcript's tail. */
  version?: (sessionId: string) => Promise<string | null>;
  /** Whether this harness hands its hooks Claude Code's layout: a `transcript_path` whose tail states the version and model, the `.claude` census, and a `PreToolUse` whose output reaches the model. */
  claudeLayout: boolean;
  /** Whether this harness's `PreToolUse` output reaches the model, so the fit push is worth asking. Claude Code and Codex do; Copilot's has no context field. */
  pushesPreTool: boolean;
  /** Names the hook payload gives a tool that the harness's action table does not list, with the action each is. */
  aliases?: ReadonlyMap<string, CanonicalAction>;
  /** The failure text of a finished tool call whose payload carries none (Codex's `tool_response` has no exit code), or undefined when the call did not fail or this cannot tell. */
  failure?: (input: Input) => Promise<string | undefined>;
  /** What this harness's own recording hook does with the same payload, run beside the recall so one entry per event both records and pushes. It never throws. */
  record?: (stdin: string, storeDir: string, now: () => number) => Promise<void>;
}

/** Claude Code's reply: `hookSpecificOutput`, named for the event that fired. */
const CLAUDE_EVENTS: { readonly [event: string]: string } = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-tool': 'PreToolUse' };

export const CLAUDE_DIALECT: Dialect = {
  harness: 'claude-code',
  readPayload: (payload) => payload,
  // A failed tool call names the event the harness fired (PostToolUse and PostToolUseFailure both reach this handler); every other event is named by the hook that answers it.
  answer: (event, context, payload) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: event === 'post-tool' ? str(payload.hook_event_name) ?? 'PostToolUseFailure' : CLAUDE_EVENTS[event] ?? event, additionalContext: context } })}\n`,
  claudeLayout: true,
  pushesPreTool: true,
};

/** Copilot's camelCase payload names beside the snake_case ones its PascalCase registrations get: the same field, either spelling. */
const COPILOT_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['session_id', 'sessionId'],
  ['tool_name', 'toolName'],
  ['tool_input', 'toolArgs'],
  ['hook_event_name', 'hookEventName'],
];

/** `toolArgs` arrives as a JSON string in the camelCase payload and as an object in the snake_case one. */
const argsOf = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** How much of `events.jsonl` the version read looks at: `session.start` is its first event, so a head is enough and the read stays bounded. */
const HEAD_BYTES = 16 * 1024;

/** The `copilotVersion` of the first `session.start` in the head of one events file; null when the file, the event, or the field is not there. */
const headVersionOf = async (file: string): Promise<string | null> => {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event) || event.type !== 'session.start' || !isRecord(event.data)) continue;
        return str(event.data.copilotVersion) ?? null;
      } catch {
        // A line the head cut in two, or one that is not JSON.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
};

/** The lowest-numbered rotated archive `events.N.jsonl` in a session folder (the reader's oldest-first order), or undefined when the session has none. */
const oldestArchiveOf = async (folder: string): Promise<string | undefined> => {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return undefined;
  }
  const numbered = names.flatMap((name) => {
    const n = ARCHIVE.exec(name)?.[1];
    return n === undefined ? [] : [{ name, n: Number(n) }];
  });
  return numbered.sort((a, b) => a.n - b.n)[0]?.name;
};

/**
 * The `copilotVersion` of a session's `session.start` event, from the head of `session-state/<id>/events.jsonl`. A rotated session's live head may hold only a journal link and
 * checkpoint replays (copilot.ts), so when it has no `session.start` the head of the lowest-numbered archive, where the session began, is read instead. Null when none states it.
 */
export const copilotVersionOf = async (root: string, sessionId: string): Promise<string | null> => {
  // A session id names a folder: one with a separator in it names no session of ours.
  if (!SAFE_ID.test(sessionId)) return null;
  const folder = join(root, 'session-state', sessionId);
  const live = await headVersionOf(join(folder, 'events.jsonl'));
  if (live !== null) return live;
  const oldest = await oldestArchiveOf(folder);
  return oldest === undefined ? null : headVersionOf(join(folder, oldest));
};

/**
 * Copilot's answer is a top-level `additionalContext` (never Claude's `hookSpecificOutput`) for the session start and a failed tool call. The prompt is answered through
 * `userPromptTransformed`, whose `modifiedTransformedPrompt` replaces the model-facing prompt: the prompt text is kept whole and the recall line follows it, and a payload that
 * does not carry the prompt gets no answer, because a reply without it would replace the prompt with the recall line alone. `preToolUse` output has no context field, so it gets none.
 */
const copilotAnswer = (event: string, context: string, payload: Input): string | undefined => {
  if (event === 'session-start' || event === 'post-tool') return `${JSON.stringify({ additionalContext: context })}\n`;
  const prompt = event === 'prompt' ? str(payload.transformedPrompt) : undefined;
  return prompt === undefined ? undefined : `${JSON.stringify({ modifiedTransformedPrompt: `${prompt}\n\n${context}` })}\n`;
};

export const copilotDialect = (env: { [name: string]: string | undefined }, home: string): Dialect => ({
  harness: 'copilot',
  readPayload: (payload) => {
    const read: Input = { ...payload };
    for (const [snake, camel] of COPILOT_NAMES) if (read[snake] === undefined && payload[camel] !== undefined) read[snake] = payload[camel];
    if (read.tool_input !== undefined) read.tool_input = argsOf(read.tool_input);
    return read;
  },
  answer: copilotAnswer,
  version: (sessionId) => copilotVersionOf(copilotRoot(env, home), sessionId),
  claudeLayout: false,
  pushesPreTool: false,
});

/** Codex's reply is Claude Code's `hookSpecificOutput` (the same output schema), except that a tool call's `PostToolUse` is the one event Codex fires for success and failure alike. */
const codexAnswer = (event: string, context: string): string => `${JSON.stringify({ hookSpecificOutput: { hookEventName: event === 'post-tool' ? 'PostToolUse' : (CLAUDE_EVENTS[event] ?? event), additionalContext: context } })}\n`;

/** A Codex hook payload has Claude Code's keys, but `transcript_path` is a rollout (never a Claude transcript), and the call id is `tool_use_id`. */
const codexFailure = async (input: Input): Promise<string | undefined> => {
  const tool = str(input.tool_name);
  // Only a shell call has an exit line, so any other call is not worth reading the rollout for.
  if (tool === undefined || HOOK_TOOLS.get(tool) !== 'shell.exec') return undefined;
  return callFailureOf(str(input.transcript_path), str(input.tool_use_id));
};

export const codexDialect = (home: string): Dialect => ({
  harness: 'codex',
  readPayload: (payload) => payload,
  answer: (event, context) => codexAnswer(event, context),
  claudeLayout: false,
  pushesPreTool: true,
  aliases: HOOK_TOOLS,
  failure: codexFailure,
  // Loaded here so the Claude Code and Copilot hooks never pay for the recording modules.
  record: async (stdin, storeDir, now) => {
    const { runCodexHook } = await import('./codex-hook.js');
    const { appendOwnerOnly } = await import('./owner-only.js');
    await runCodexHook(stdin, { storeDir, home, now, append: appendOwnerOnly });
  },
});

/** The dialect a `--harness` name asks for; undefined for a name this program has no dialect for, which the entry answers with silence. */
export const dialectOf = (name: string | undefined, env: { [name: string]: string | undefined }, home: string): Dialect | undefined => {
  if (name === undefined || name === 'claude-code') return CLAUDE_DIALECT;
  if (name === 'codex') return codexDialect(home);
  return name === 'copilot' ? copilotDialect(env, home) : undefined;
};

/** The value of `--harness <name>` (or `--harness=<name>`) in a hook command's arguments; undefined when the flag is absent. A flag with no value reads as the empty name, which no dialect has. */
export const harnessFlag = (argv: readonly string[]): string | undefined => {
  const at = argv.findIndex((arg) => arg === '--harness' || arg.startsWith('--harness='));
  if (at < 0) return undefined;
  const arg = argv[at] ?? '';
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (argv[at + 1] ?? '');
};
