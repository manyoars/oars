// A scripted fake harness. The test (or `run-fake`) passes a script: a function from the run's request to the faults to inject; no fault means a clean valid run
// that passes its check. It writes a real temp folder and a transcript file, so the runner's hashing and cleanup are exercised, and it opens no network and no store.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_TOOL } from './order.js';
import type { CheckResult, ExitKind, HarnessAdapter, Prepared, RunRequest, RunResult, TokenCounts, ToolPin } from './harness.js';

/** Each field overrides what the fake would report for a clean run. */
export interface Fault {
  exit?: ExitKind;
  installedPins?: ToolPin[];
  taskSetVersion?: string;
  fixtureTag?: string;
  manifestVersion?: string;
  harnessVersion?: string;
  modelId?: string;
  check?: CheckResult;
  tokens?: TokenCounts;
  /** True: the harness leaves no transcript file. */
  noTranscript?: boolean;
  /** The adapter call that throws instead of returning, to prove the runner keeps the run book. */
  throwIn?: 'prepare' | 'run' | 'check';
  /** True: the agent never calls its arm's tool (the order promises valid runs, not that the tool is called). */
  noToolCall?: boolean;
  /** Replaces the whole transcript text, to prove a transcript the stager cannot use. */
  transcriptText?: string;
}

export type Script = (request: RunRequest) => Fault;

export const CLEAN: Script = () => ({});

/** A session id in the shape Claude Code writes, derived from the run id so a second run of the same script writes the same bytes. */
export const sessionIdOf = (runId: string): string => {
  const hex = createHash('sha256').update(runId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * The transcript a Claude Code run writes, as `real-work-fixture.ts` shapes it: a user line, then an assistant `tool_use` line and a user `tool_result` line per call.
 * The tool arm calls `mcp__<arm>__lookup` unless the fault says the agent did not; every run reads one file.
 */
export const fakeTranscript = (request: RunRequest, harnessVersion: string, modelId: string, calls: boolean): string => {
  const sessionId = sessionIdOf(request.runId);
  const lines: string[] = [];
  let n = 0;
  const at = (): string => `2026-11-16T12:00:${String(n % 60).padStart(2, '0')}.000Z`;
  const base = { parentUuid: null, isSidechain: false, version: harnessVersion, sessionId };
  const uuid = (kind: string): string => `${sessionId.slice(0, 8)}-${kind}${String(n).padStart(3, '0')}-4222-8222-222222222222`;
  n += 1;
  lines.push(JSON.stringify({ type: 'user', uuid: uuid('b'), timestamp: at(), cwd: '/work/app', message: { role: 'user', content: `task ${request.taskId}` }, ...base }));
  const tools = [{ name: 'Read', input: { file_path: 'src/a.ts' } }, ...(calls && request.arm !== NO_TOOL ? [{ name: `mcp__${request.arm}__lookup`, input: { q: 1 } }] : [])];
  for (const tool of tools) {
    n += 1;
    const id = `toolu_${String(n)}${sessionId.slice(0, 4)}`;
    lines.push(JSON.stringify({ type: 'assistant', uuid: uuid('a'), timestamp: at(), requestId: `req_${String(n)}${sessionId.slice(0, 4)}`, message: { role: 'assistant', model: modelId, content: [{ type: 'tool_use', id, name: tool.name, input: tool.input }], usage: { input_tokens: 100, output_tokens: 50 } }, ...base }));
    lines.push(JSON.stringify({ type: 'user', uuid: uuid('c'), timestamp: at(), cwd: '/work/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, ...base }));
  }
  return `${lines.join('\n')}\n`;
};

export interface FakeHarness extends HarnessAdapter {
  /** Run ids passed to `prepare`, in order. */
  readonly prepared: string[];
  /** Temp folders still on disk (should be empty once a run ends). */
  readonly open: Set<string>;
}

const DEFAULT_TOKENS: TokenCounts = { input: 1000, cache: 4000, output: 200 };

export const makeFake = (script: Script = CLEAN): FakeHarness => {
  const prepared: string[] = [];
  const open = new Set<string>();
  const exitCodes: { readonly [kind in ExitKind]: number } = { ok: 0, crash: 139, 'api-error': 1, 'rate-limit': 1, 'auth-rejected': 1, 'disk-full': 1, 'network-down': 1 };
  return {
    prepared,
    open,
    prepare: async (request): Promise<Prepared> => {
      const fault = script(request);
      if (fault.throwIn === 'prepare') throw new Error('fake prepare fault');
      const dir = await mkdtemp(join(tmpdir(), 'fleet-fake-'));
      prepared.push(request.runId);
      open.add(dir);
      return {
        dir,
        installedPins: fault.installedPins ?? request.expected.toolPins,
        taskSetVersion: fault.taskSetVersion ?? request.expected.taskSetVersion,
        fixtureTag: fault.fixtureTag ?? request.expected.fixtureTag,
        manifestVersion: fault.manifestVersion ?? request.expected.manifestVersion,
        dispose: async () => {
          await rm(dir, { recursive: true, force: true });
          open.delete(dir);
        },
      };
    },
    run: async (folder, request): Promise<RunResult> => {
      const fault = script(request);
      if (fault.throwIn === 'run') throw new Error('fake run fault');
      const kind = fault.exit ?? 'ok';
      const transcriptPath = fault.noTranscript === true ? null : join(folder.dir, 'transcript.jsonl');
      const harnessVersion = fault.harnessVersion ?? request.expected.harnessVersion;
      const modelId = fault.modelId ?? request.expected.modelId;
      if (transcriptPath !== null) await writeFile(transcriptPath, fault.transcriptText ?? fakeTranscript(request, harnessVersion, modelId, fault.noToolCall !== true));
      return {
        exit: { kind, code: exitCodes[kind] },
        transcriptPath,
        harnessVersion,
        modelId,
        tokens: fault.tokens ?? DEFAULT_TOKENS,
        poolSessionId: null,
      };
    },
    check: (_folder, request): Promise<CheckResult> => {
      const fault = script(request);
      if (fault.throwIn === 'check') return Promise.reject(new Error('fake check fault'));
      return Promise.resolve(fault.check ?? 'pass');
    },
  };
};
