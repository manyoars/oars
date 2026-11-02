// The hook entry points. Each takes the hook's stdin and returns the text for stdout (or undefined for none). They are fail-open:
// any error inside one is swallowed, so a hook can never fail or block a Claude Code session. Each call is counted in
// `hook-calls.jsonl` with its own duration, so `measure` can count recall calls per session and the timings can be checked.
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfigDir } from '../credentials.js';
import { cursorRoot } from './cursor.js';
import { signatureOf } from './extract.js';
import { appendHookCall } from './hook-calls.js';
import { contextBlock, readIndex } from './hook-index.js';
import { makeRedactor } from './redact.js';
import type { HookCall } from './schema.js';
import { deposit, depositSession, readSaved, type SessionsRuntime } from './store.js';

export type HookEvent = HookCall['event'];

export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'post-tool', 'stop', 'nightly'];

const TOP = 5;
const MAX_CHARS = 1200;

interface Input {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Input => typeof value === 'object' && value !== null && !Array.isArray(value);

const parse = (stdin: string): Input => {
  try {
    const parsed: unknown = JSON.parse(stdin);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const additional = (eventName: string, context: string): string => `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } })}\n`;

interface Outcome {
  /** What goes to stdout. */
  output?: string;
  hit: boolean;
  /** A failure the hook survived (fail-open), recorded as the hook-call `error`. */
  error?: string;
}

const sessionStart = async (runtime: SessionsRuntime, input: Input): Promise<Outcome> => {
  const cwd = str(input.cwd);
  const index = cwd === undefined ? undefined : await readIndex(runtime.storeDir);
  const block = index === undefined || cwd === undefined ? undefined : contextBlock(index, { cwd, top: TOP, maxChars: MAX_CHARS });
  return block === undefined ? { hit: false } : { output: additional('SessionStart', block), hit: true };
};

/** A failed tool arrives as PostToolUseFailure with the text in `error` (Bash and PowerShell start it with `Exit code N`); a PostToolUse response that starts that way is read too. */
const failureText = (input: Input): string | undefined => {
  const failed = str(input.error);
  if (failed !== undefined) return failed;
  const response = str(input.tool_response);
  return response !== undefined && /^Exit code \d+/.test(response) ? response : undefined;
};

const postTool = async (runtime: SessionsRuntime, input: Input): Promise<Outcome> => {
  const tool = str(input.tool_name);
  const text = failureText(input);
  if (tool === undefined || text === undefined) return { hit: false };
  const index = await readIndex(runtime.storeDir);
  if (index === undefined) return { hit: false };
  const found = index.signatures[signatureOf(tool, text, makeRedactor(index.redactDomains))];
  if (found === undefined) return { hit: false };
  const followed = found.followed.map(([next]) => next).join(', ');
  const context = `oars recall: seen in ${String(found.sessions)} sessions; what followed: ${followed === '' ? 'nothing recorded' : followed}`;
  return { output: additional(str(input.hook_event_name) ?? 'PostToolUseFailure', context), hit: true };
};

const stop = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const transcript = str(input.transcript_path);
  return { hit: transcript !== undefined && (await depositSession(runtime, transcript, now)) === 'deposited' };
};

const nightly = async (runtime: SessionsRuntime, now: () => number): Promise<Outcome> => {
  const saved = await readSaved(runtime.storeDir);
  if (saved.allow.length === 0) return { hit: false };
  const result = await deposit(runtime, { allow: saved.allow, redactDomains: saved.redactDomains, now });
  // A Cursor store that could not be read does not fail the run, so the record carries it or nobody sees it.
  const unreadable = result.cursorUnreadable[0];
  return unreadable === undefined ? { hit: true } : { hit: true, error: firstLine(unreadable) };
};

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** The runtime a hook process runs with. Only `nightly` reads the Cursor store (a saved `--allow cursor`); the Stop path stays free of it. */
export const hookRuntime = (
  event: HookEvent,
  env: { [name: string]: string | undefined },
  platform: NodeJS.Platform,
  home: string,
  io: Pick<SessionsRuntime, 'stdin' | 'stdout'>,
): SessionsRuntime => ({
  storeDir: join(defaultConfigDir(env, platform, home), 'oars', 'sessions'),
  projectsRoot: join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
  ...(event === 'nightly' ? { cursorRoot: cursorRoot(platform, env, home) } : {}),
  ...io,
});

/**
 * Runs one hook. It never fails or blocks the session it runs in: whatever happens, it resolves (the process exits 0), and the
 * hook-call line records the outcome, with the failure's first line when there was one, so the record is evidence, not a claim.
 */
export const runHook = async (event: HookEvent, stdin: string, runtime: SessionsRuntime, now: () => number): Promise<string | undefined> => {
  const started = performance.now();
  let session: string | null = null;
  let outcome: Outcome = { hit: false };
  let failed: string | undefined;
  try {
    const input = parse(stdin);
    session = str(input.session_id) ?? null;
    if (event === 'session-start') outcome = await sessionStart(runtime, input);
    else if (event === 'post-tool') outcome = await postTool(runtime, input);
    else if (event === 'stop') outcome = await stop(runtime, input, now);
    else outcome = await nightly(runtime, now);
  } catch (failure) {
    failed = firstLine(failure);
  }
  try {
    await appendHookCall(runtime.storeDir, { at: new Date(now()).toISOString(), event, session, hit: outcome.hit, ms: Math.round(performance.now() - started), error: failed ?? outcome.error ?? null });
  } catch {
    // A counter that cannot be written must not cost the session its context.
  }
  return outcome.output;
};
