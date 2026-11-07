// The hook entry points. Each takes the hook's stdin and returns the text for stdout (or undefined for none). They are fail-open:
// any error inside one is swallowed, so a hook can never fail or block a Claude Code session. Each call is counted in
// `hook-calls.jsonl` with its own duration, so `measure` can count recall calls per session and the timings can be checked.
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfigDir } from '../credentials.js';
import { noEmit, type Emit } from '../telemetry/emit.js';
import { frameWords, HOOK_HARNESS, recallFields } from '../telemetry/fields.js';
import { cursorRoot } from './cursor.js';
import { SOURCES, sourceLabel } from './sources.js';
import { ACTION_TABLES, actionOf } from './actions.js';
import { errorCodeOf, signatureOf } from './extract.js';
import { appendHookCall } from './hook-calls.js';
import { contextBlock, readIndex, type HookIndex } from './hook-index.js';
import type { Recall } from './recall-object.js';
import { bundleNext, frameKeyOf, lastTable, mergePositions, positionsRecall, recoveryDecision, recoveryRecall, signatureRecall, isSignatureRetry, type Asker, type NextInput, type NextReads } from './recall-next.js';
import { pushRecall, tailOf } from './recall-push.js';
import { statedAt, statedOf } from './transcript-tail.js';
import { toolShapeId } from './recall-reads.js';
import { makeRedactor } from './redact.js';
import type { HookCall } from './schema.js';
import { errorLine, inputKey, logStep, newContext, runDeposit, stampKey, tryLog, type StepReport } from './steps.js';
import { deposit, depositSession, readSaved, type SessionsRuntime } from './store.js';
import { recordSurvival } from './survival.js';
import type { NightlyTelemetry } from '../telemetry/health.js';

export type HookEvent = HookCall['event'];

export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'prompt', 'pre-tool', 'post-tool', 'stop', 'nightly'];

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
  /** A lookup hook that read the index and searched it: only then did a recall query run, so only then is an ok `recall` row logged. */
  queried: boolean;
  /** A failure the hook survived (fail-open), recorded as the hook-call `error`. */
  error?: string;
  /** The recall a pre-tool push made, for telemetry: held when the arm kept it from the agent. */
  recall?: Recall;
  /** The model the harness told this hook it runs, when its input says. */
  model?: string;
}

/** What a next-node read needs of the hook's input: the session, the transcript's tail (version, model), and the clock; undefined when the harness gave no session, since the holdback arm is the session's. */
const nextInputOf = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<{ next: NextInput; asker: Asker } | undefined> => {
  const sid = str(input.session_id);
  if (sid === undefined) return undefined;
  const transcript = str(input.transcript_path);
  const tail = transcript === undefined ? '' : await tailOf(transcript);
  const { harnessVersion } = statedOf(tail);
  return { next: { storeDir: runtime.storeDir, sid, tail, platform: process.platform, at: new Date(now()).toISOString() }, asker: { harness: HOOK_HARNESS, harnessVersion } };
};

/**
 * The split-positions table (Item 3): the kept bundle's positions first, the local pool's second. A `repeat` read (UserPromptSubmit) goes out only when the table differs from
 * the one this session was last sent, shown or held, so a held session and a shown one hear the same number of times.
 */
const positionsTable = async (runtime: SessionsRuntime, input: Input, now: () => number, index: HookIndex | undefined, repeat: boolean): Promise<Recall | undefined> => {
  const prepared = await nextInputOf(runtime, input, now);
  if (prepared === undefined) return undefined;
  const bundle = await bundleNext(runtime.storeDir, prepared.asker);
  const positions = mergePositions(bundle?.positions ?? [], index?.positionsByFrame?.[frameKeyOf(prepared.asker)] ?? []);
  if (positions.length === 0) return undefined;
  const previous = repeat ? await lastTable(runtime.storeDir, prepared.next.sid) : undefined;
  return positionsRecall(prepared.next, prepared.asker, positions, bundle?.poolVersion ?? index?.at ?? '', previous);
};

const sessionStart = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const cwd = str(input.cwd);
  const index = await readIndex(runtime.storeDir);
  const block = index === undefined || cwd === undefined ? undefined : contextBlock(index, { cwd, top: TOP, maxChars: MAX_CHARS });
  const recall = await positionsTable(runtime, input, now, index, false);
  const model = str(input.model);
  const shown = recall?.arm === 'shown' ? recall.answer.rendered : undefined;
  const text = [block, shown].filter((part) => part !== undefined).join('\n\n');
  return {
    hit: text !== '' || recall !== undefined,
    queried: index !== undefined || recall !== undefined,
    ...(text === '' ? {} : { output: additional('SessionStart', text) }),
    ...(recall === undefined ? {} : { recall }),
    ...(model === undefined ? {} : { model }),
  };
};

/** UserPromptSubmit: the positions table again, only when it changed since this session's last one. */
const prompt = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const recall = await positionsTable(runtime, input, now, await readIndex(runtime.storeDir), true);
  if (recall === undefined) return { hit: false, queried: false };
  return recall.arm === 'shown' ? { output: additional('UserPromptSubmit', recall.answer.rendered), hit: true, queried: true, recall } : { hit: true, queried: true, recall };
};

const inputKeys = (input: Input): string[] => (isRecord(input.tool_input) ? Object.keys(input.tool_input) : []);

/**
 * The fit push. The only output this hook writes is `additionalContext`: it holds no permission decision and changes no input, so whatever it does, the call runs as asked.
 * A call with no read says nothing and logs no recall step: that is nearly every call, and nobody asked. A held push is a hit, for what it would have shown, with no output.
 */
const preTool = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const sid = str(input.session_id);
  const tool = str(input.tool_name);
  if (sid === undefined || tool === undefined) return { hit: false, queried: false };
  const index = await readIndex(runtime.storeDir);
  if (index === undefined) return { hit: false, queried: false };
  const recall = await pushRecall({ storeDir: runtime.storeDir, sid, tool, keys: inputKeys(input), transcript: str(input.transcript_path), platform: process.platform, at: new Date(now()).toISOString(), index });
  if (recall === undefined) return { hit: false, queried: false };
  return recall.arm === 'shown' ? { output: additional('PreToolUse', recall.answer.rendered), hit: true, queried: true, recall } : { hit: true, queried: true, recall };
};

/** A failed tool arrives as PostToolUseFailure with the text in `error` (Bash and PowerShell start it with `Exit code N`); a PostToolUse response that starts that way is read too. */
const failureText = (input: Input): string | undefined => {
  const failed = str(input.error);
  if (failed !== undefined) return failed;
  const response = str(input.tool_response);
  return response !== undefined && /^Exit code \d+/.test(response) ? response : undefined;
};

/**
 * The recovery edge (Item 2): what followed a failure of this action and error class, from the kept bundle for the session's setup and then the local pool, held to A33's
 * holdback like every next-node read. A same-step retry or a local edge under the floor says nothing, signature line included; the signature line answers only a failure no cell covers.
 */
const postTool = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const tool = str(input.tool_name);
  const text = failureText(input);
  const prepared = tool === undefined || text === undefined ? undefined : await nextInputOf(runtime, input, now);
  if (tool === undefined || text === undefined || prepared === undefined) return { hit: false, queried: false };
  const index = await readIndex(runtime.storeDir);
  const bundle: NextReads | undefined = await bundleNext(runtime.storeDir, prepared.asker);
  if (index === undefined && bundle === undefined) return { hit: false, queried: false };
  const action = actionOf(ACTION_TABLES['claude-code'], tool).action;
  const code = errorCodeOf(text);
  const decision = recoveryDecision(bundle, index === undefined ? undefined : { recovery: index.recoveryByFrame?.[frameKeyOf(prepared.asker)] ?? {}, poolVersion: index.at }, action, code);
  const event = str(input.hook_event_name) ?? 'PostToolUseFailure';
  if (decision.kind === 'serve') {
    const recall = await recoveryRecall(prepared.next, prepared.asker, action, code, decision);
    return recall.arm === 'shown' ? { output: additional(event, recall.answer.rendered), hit: true, queried: true, recall } : { hit: true, queried: true, recall };
  }
  // A same-step retry, a local cell too thin to serve, and a cell whose top is that nothing followed all end the lookup: a cell that exists but says nothing is not a reason to fall back to a signature count.
  if (decision.kind === 'retry' || decision.kind === 'floor' || decision.kind === 'ended') return { hit: false, queried: true };
  const sig = signatureOf(tool, text, makeRedactor(index?.redactDomains ?? []));
  const found = index?.signatures[sig];
  if (index === undefined || found === undefined || isSignatureRetry(tool, found)) return { hit: false, queried: true };
  const recall = await signatureRecall(prepared.next, prepared.asker, tool, sig, found, index.at);
  return recall.arm === 'shown' ? { output: additional(event, recall.answer.rendered), hit: true, queried: true, recall } : { hit: true, queried: true, recall };
};

const stop = async (runtime: SessionsRuntime, input: Input, now: () => number): Promise<Outcome> => {
  const transcript = str(input.transcript_path);
  if (transcript === undefined) return { hit: false, queried: false };
  // The SessionEnd hook is the `stop` trigger (spec 4.1); derive and index follow at the nightly run, so only a deposit row is logged.
  const deposited = await runDeposit(newContext(runtime.storeDir, now, 'stop'), false, inputKey('stop', [transcript], []), async (trace) => ({ value: await depositSession(runtime, transcript, now, trace), in: { transcript: 1 } }));
  return { hit: deposited === 'deposited', queried: false };
};

/** What the nightly run measures about itself for telemetry: the clock it reads and the time its deposit took. */
interface Timing {
  clock: () => number;
  parseMs: number;
}

const nightlyRun = async (runtime: SessionsRuntime, now: () => number, timing: Timing): Promise<Outcome> => {
  // A state.json that cannot be read is a failed deposit run like any other: its error row and the skipped derive row (spec 4.4) are logged.
  const saved = await readSaved(runtime.storeDir).catch((failure: unknown) => runDeposit<Awaited<ReturnType<typeof readSaved>>>(newContext(runtime.storeDir, now, 'nightly'), true, inputKey('nightly', [], []), () => Promise.reject(failure instanceof Error ? failure : new Error(String(failure)))));
  const result = await runDeposit(newContext(runtime.storeDir, now, 'nightly'), true, inputKey('nightly', saved.allow, saved.redactDomains), async (trace) => {
    const parseStart = timing.clock();
    const done = await deposit(runtime, { allow: saved.allow, redactDomains: saved.redactDomains, now }, trace);
    timing.parseMs = timing.clock() - parseStart;
    return { value: done, in: { transcript: done.sessions + done.subagents + done.unchanged } };
  });
  const survival = await recordSurvival(runtime, saved.allow, now);
  // A source store that could not be read does not fail the run, so the record carries it or nobody sees it.
  const counts = Object.entries(result.sources);
  const unreadable = counts.flatMap(([, tally]) => tally.unreadableLogged)[0];
  if (unreadable !== undefined) return { hit: true, queried: false, error: await errorLine(runtime.storeDir, unreadable) };
  // A skip for an unsafe session id is likewise reported, never silent (the `rejected` doc in sources.ts); an unreadable store, which names its own reason, takes precedence.
  const skipped = counts.find(([, tally]) => tally.rejected > 0);
  if (skipped !== undefined) return { hit: true, queried: false, error: `Skipped ${String(skipped[1].rejected)} ${sourceLabel(skipped[0], runtime.sources ?? SOURCES)} sessions whose id is not a safe file name` };
  // A survival read that fails every night is otherwise invisible, for the same reason; it comes last because the run itself did not lose a session.
  return survival === null ? { hit: true, queried: false, error: await errorLine(runtime.storeDir, 'Commit survival not read this run.') } : { hit: true, queried: false };
};

/** The nightly run, then (when telemetry is given) the store-health snapshot and the run's cost. Recording happens after the run and cannot change its outcome or its error. */
const nightly = async (runtime: SessionsRuntime, now: () => number, telemetry: NightlyTelemetry | undefined): Promise<Outcome> => {
  const timing: Timing = { clock: telemetry?.now ?? now, parseMs: 0 };
  const started = timing.clock();
  let outcome: Outcome | undefined;
  let failure: unknown;
  let failed = false;
  try {
    outcome = await nightlyRun(runtime, now, timing);
  } catch (thrown) {
    failure = thrown;
    failed = true;
  }
  if (telemetry !== undefined) {
    // Loaded here so the hooks that run before every tool call never pay for the telemetry modules.
    const { recordRunCost, recordStoreHealth } = await import('../telemetry/health.js');
    await recordStoreHealth(telemetry, runtime);
    recordRunCost(telemetry, { totalMs: timing.clock() - started, parseMs: timing.parseMs, failed: failed || outcome?.error !== undefined });
  }
  if (failed) throw failure;
  return outcome ?? { hit: false, queried: false };
};

/** What a lookup hook looks up, as its recall key (spec 4.2 names none for a lookup): the cwd for session-start, the failure's signature for post-tool, the call's shape for pre-tool; null when it had nothing to look up. */
const lookupKey = (event: HookEvent, input: Input): string | null => {
  if (event === 'session-start') {
    const cwd = str(input.cwd);
    return cwd === undefined ? null : stampKey(event, cwd);
  }
  if (event === 'prompt') return stampKey(event, 'positions');
  const tool = str(input.tool_name);
  if (event === 'pre-tool') return tool === undefined ? null : stampKey(event, toolShapeId(tool, inputKeys(input)));
  const text = failureText(input);
  return event === 'post-tool' && tool !== undefined && text !== undefined ? stampKey(event, signatureOf(tool, text, makeRedactor([]))) : null;
};

/** The runtime a hook process runs with. Only `nightly` reads the non-Claude stores (a saved `--allow cursor` or `--allow codex`); the Stop path stays free of it. */
export const hookRuntime = (
  event: HookEvent,
  env: { [name: string]: string | undefined },
  platform: NodeJS.Platform,
  home: string,
  io: Pick<SessionsRuntime, 'stdin' | 'stdout'>,
): SessionsRuntime => ({
  storeDir: join(defaultConfigDir(env, platform, home), 'oars', 'sessions'),
  projectsRoot: join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'),
  ...(event === 'nightly' ? { cursorRoot: cursorRoot(platform, env, home), sourceRoots: Object.fromEntries(SOURCES.map((source) => [source.name, source.root(platform, env, home)])) } : {}),
  ...io,
});

/** What the nightly run records with, and nothing for any other hook: the telemetry folder sits beside the session store under the config directory, so `oars telemetry` and the nightly run read and write the same one. The version is read only for the nightly run, so the per-tool hooks never touch the manifest. */
export const nightlyTelemetry = (
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  version: () => string,
  now: () => number,
): NightlyTelemetry | undefined =>
  event === 'nightly' ? { env, telemetry: { dir: join(defaultConfigDir(env, platform, home), 'oars', 'telemetry'), platform }, version: version(), now } : undefined;

/**
 * Runs one hook. It never fails or blocks the session it runs in: whatever happens, it resolves (the process exits 0), and the
 * hook-call line records the outcome, with the failure's first line when there was one, so the record is evidence, not a claim.
 */
export const runHook = async (
  event: HookEvent,
  stdin: string,
  runtime: SessionsRuntime,
  now: () => number,
  telemetry?: NightlyTelemetry,
  emit: Emit = noEmit,
): Promise<string | undefined> => {
  const started = performance.now();
  let session: string | null = null;
  let outcome: Outcome = { hit: false, queried: false };
  let failed = false;
  let failure: unknown;
  let key: string | null = null;
  let transcript: string | undefined;
  try {
    const input = parse(stdin);
    transcript = str(input.transcript_path);
    key = lookupKey(event, input);
    session = str(input.session_id) ?? null;
    if (event === 'session-start') outcome = await sessionStart(runtime, input, now);
    else if (event === 'prompt') outcome = await prompt(runtime, input, now);
    else if (event === 'pre-tool') outcome = await preTool(runtime, input, now);
    else if (event === 'post-tool') outcome = await postTool(runtime, input, now);
    else if (event === 'stop') outcome = await stop(runtime, input, now);
    else outcome = await nightly(runtime, now, telemetry);
  } catch (thrown) {
    failure = thrown;
    failed = true;
  }
  const ms = Math.round(performance.now() - started);
  // The failure line is masked once, the same for the hook-calls line and the step row beside it; both writes are guarded, so a counter
  // that cannot be written never costs the session its context.
  const line = failed ? await errorLine(runtime.storeDir, failure).catch(() => 'unknown error') : outcome.error ?? null;
  await tryLog(() => appendHookCall(runtime.storeDir, { at: new Date(now()).toISOString(), event, session, hit: outcome.hit, ms, startMs: Math.round(started), error: line }));
  // A lookup hook that ran a query (or failed trying) is a `recall` step started by its own trigger; the deposit hooks logged their rows as they ran.
  if (key !== null && (failed || outcome.queried)) {
    const report: StepReport = { in: { query: 1 }, out: failed ? {} : { matches: outcome.hit ? 1 : 0 }, key };
    await tryLog(() => logStep(newContext(runtime.storeDir, now, event), 'recall', failed ? 'error' : 'ok', ms, report, line));
  }
  // After the answer is settled and the local rows are written; it runs before hook-bin prints, at the cost measured in t876 item 5. `emit` never throws. A push states its own frame;
  // every other fire reads the transcript's tail the way a push does, so the version and model are there on a miss, a post-tool, and a stop. (A nightly run has no hook input, so it has no transcript to read.)
  const { recall } = outcome;
  const stated = recall?.frame !== undefined || transcript === undefined ? undefined : await statedAt(transcript);
  emit('hook', {
    name: event,
    latencyMs: ms,
    outcome: failed ? 'error' : recall?.arm === 'held' ? 'held' : outcome.hit ? 'hit' : 'miss',
    bytes: Buffer.byteLength(outcome.output ?? ''),
    // The nightly is the scheduled task, not a harness's hook: it names no harness.
    ...frameWords(event === 'nightly' ? undefined : recall?.frame?.harness ?? HOOK_HARNESS, recall?.frame?.harnessVersion ?? stated?.harnessVersion, recall?.frame?.model ?? outcome.model ?? stated?.model),
  });
  // A push is a recall: its read is the family its query names (the `fit` push names none), and its arm is the exposure record, as a count of one.
  if (recall !== undefined) emit('recall', recallFields(recall, [recall.query.family ?? 'fit']));
  return outcome.output;
};
