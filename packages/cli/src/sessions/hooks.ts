// The hook entry points. Each takes the hook's stdin and returns the text for stdout (or undefined for none). They are fail-open:
// any error inside one is swallowed, so a hook can never fail or block a Claude Code session. Each call is counted in
// `hook-calls.jsonl` with its own duration, so `measure` can count recall calls per session and the timings can be checked.
import { performance } from 'node:perf_hooks';
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
  await deposit(runtime, { allow: saved.allow, redactDomains: saved.redactDomains, now });
  return { hit: true };
};

export const runHook = async (event: HookEvent, stdin: string, runtime: SessionsRuntime, now: () => number): Promise<string | undefined> => {
  const started = performance.now();
  try {
    const input = parse(stdin);
    let outcome: Outcome;
    if (event === 'session-start') outcome = await sessionStart(runtime, input);
    else if (event === 'post-tool') outcome = await postTool(runtime, input);
    else if (event === 'stop') outcome = await stop(runtime, input, now);
    else outcome = await nightly(runtime, now);
    try {
      await appendHookCall(runtime.storeDir, {
        at: new Date(now()).toISOString(),
        event,
        session: str(input.session_id) ?? null,
        hit: outcome.hit,
        ms: Math.round(performance.now() - started),
      });
    } catch {
      // A counter that cannot be written must not cost the session its context.
    }
    return outcome.output;
  } catch {
    // Fail-open: a hook never fails or blocks the session it runs in.
    return undefined;
  }
};
