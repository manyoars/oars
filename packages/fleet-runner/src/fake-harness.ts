// A scripted fake harness. The test (or `run-fake`) passes a script: a function from the run's request to the faults to inject; no fault means a clean valid run
// that passes its check. It writes a real temp folder and a transcript file, so the runner's hashing and cleanup are exercised, and it opens no network and no store.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  throwIn?: 'prepare' | 'run';
}

export type Script = (request: RunRequest) => Fault;

export const CLEAN: Script = () => ({});

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
      if (transcriptPath !== null) await writeFile(transcriptPath, `fake transcript of ${request.runId}\n`);
      return {
        exit: { kind, code: exitCodes[kind] },
        transcriptPath,
        harnessVersion: fault.harnessVersion ?? request.expected.harnessVersion,
        modelId: fault.modelId ?? request.expected.modelId,
        tokens: fault.tokens ?? DEFAULT_TOKENS,
        poolSessionId: null,
      };
    },
    check: (_folder, request): Promise<CheckResult> => Promise.resolve(script(request).check ?? 'pass'),
  };
};
