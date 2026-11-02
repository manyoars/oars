// The hook entry points. Each takes the hook's stdin and returns the text for stdout (or undefined for none). They are fail-open:
// any error inside one is swallowed, so a hook can never fail or block a Claude Code session. Each call is counted in
// `hook-calls.jsonl` with its own duration, so `measure` can count recall calls per session and the timings can be checked.
import { performance } from 'node:perf_hooks';
import { signatureOf } from './extract.js';
import { appendHookCall } from './hook-calls.js';
import { contextBlock, readIndex } from './hook-index.js';
import { makeRedactor } from './redact.js';
import type { HookCall } from './schema.js';
import { logStep, newContext, runDeposit, stampKey } from './steps.js';
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
  if (transcript === undefined) return { hit: false };
  // The SessionEnd hook is the `stop` trigger (spec 4.1); derive and index follow at the nightly run, so only a deposit row is logged.
  const deposited = await runDeposit(newContext(runtime.storeDir, now, 'stop'), false, async (trace) => ({ value: await depositSession(runtime, transcript, now, trace), in: { transcript: 1 } }));
  return { hit: deposited === 'deposited' };
};

const nightly = async (runtime: SessionsRuntime, now: () => number): Promise<Outcome> => {
  const saved = await readSaved(runtime.storeDir);
  if (saved.allow.length === 0) return { hit: false };
  await runDeposit(newContext(runtime.storeDir, now, 'nightly'), true, async (trace) => {
    const done = await deposit(runtime, { allow: saved.allow, redactDomains: saved.redactDomains, now }, trace);
    return { value: done, in: { transcript: done.sessions + done.subagents + done.unchanged } };
  });
  return { hit: true };
};

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/**
 * Runs one hook. It never fails or blocks the session it runs in: whatever happens, it resolves (the process exits 0), and the
 * hook-call line records the outcome, with the failure's first line when there was one, so the record is evidence, not a claim.
 */
export const runHook = async (event: HookEvent, stdin: string, runtime: SessionsRuntime, now: () => number): Promise<string | undefined> => {
  const started = performance.now();
  let session: string | null = null;
  let outcome: Outcome = { hit: false };
  let error: string | null = null;
  try {
    const input = parse(stdin);
    session = str(input.session_id) ?? null;
    if (event === 'session-start') outcome = await sessionStart(runtime, input);
    else if (event === 'post-tool') outcome = await postTool(runtime, input);
    else if (event === 'stop') outcome = await stop(runtime, input, now);
    else outcome = await nightly(runtime, now);
  } catch (failure) {
    error = firstLine(failure);
  }
  try {
    const ms = Math.round(performance.now() - started);
    await appendHookCall(runtime.storeDir, { at: new Date(now()).toISOString(), event, session, hit: outcome.hit, ms, error });
    // A lookup hook is a `recall` step started by its own trigger; the deposit hooks logged their rows as they ran.
    if (event === 'session-start' || event === 'post-tool') {
      const report = { in: { query: 1 }, out: { matches: outcome.hit ? 1 : 0 }, key: stampKey(event, session ?? '') };
      await logStep(newContext(runtime.storeDir, now, event), 'recall', error === null ? 'ok' : 'error', ms, report, error);
    }
  } catch {
    // A counter that cannot be written must not cost the session its context.
  }
  return outcome.output;
};
