// The runner: walks the plan, runs each slot through the adapter, voids by spec section 9, and reruns a void slot in place (so a retest stays interleaved)
// until every cell has its repeats or the order's run cap is hit. A void run is recorded with its reason and counts against the cap; it is never counted as a repeat.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CheckResult, Expected, HarnessAdapter, Prepared, RunRequest, RunResult, ToolPin } from './harness.js';
import type { FleetManifest, TaskSetManifest } from './manifest.js';
import { NO_TOOL, type Order } from './order.js';
import { cellKey, planOrder, type PlannedRun } from './plan.js';
import type { RunBook, RunRecord, ShortCell, VoidReason } from './runbook.js';

export interface RunnerOptions {
  order: Order;
  taskSet: TaskSetManifest;
  fleet: FleetManifest;
  adapter: HarnessAdapter;
  /** Injected so a run book's bytes depend on the script, not the wall clock. */
  clock: () => Date;
  operator: string;
  /**
   * Copies a valid run's transcript out of its temp folder (which `dispose` deletes) and returns the session id it will be stored under. A throw voids the run as
   * `transcript-missing`. Without it the run book's pool session id is whatever the adapter reported, else null.
   */
  stage?: (request: RunRequest, transcriptPath: string) => Promise<string>;
}

const pinsEqual = (found: ToolPin[], wanted: ToolPin[]): boolean => {
  const key = (pin: ToolPin): string => `${pin.name}@${pin.pin}`;
  const left = found.map(key).sort();
  const right = wanted.map(key).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/** The first spec section 9 cause that applies, or null for a valid run. The agent failing the task is not one. */
export const voidReasonOf = (expected: Expected, prepared: Prepared, result: RunResult): VoidReason | null => {
  switch (result.exit.kind) {
    case 'crash':
    case 'api-error':
    case 'rate-limit':
      return 'harness-failed';
    case 'auth-rejected':
      return 'sign-in-lost';
    case 'disk-full':
    case 'network-down':
      return 'machine-failed';
    case 'ok':
      break;
  }
  if (prepared.taskSetVersion !== expected.taskSetVersion) return 'task-set-changed';
  if (prepared.fixtureTag !== expected.fixtureTag) return 'fixture-tag-changed';
  if (prepared.manifestVersion !== expected.manifestVersion) return 'manifest-changed';
  if (result.harnessVersion !== expected.harnessVersion) return 'harness-version-changed';
  if (result.modelId !== expected.modelId) return 'model-changed';
  if (!pinsEqual(prepared.installedPins, expected.toolPins)) return 'tool-pin-mismatch';
  return null;
};

const expectedPins = (order: Order, arm: string, side: string | null): ToolPin[] => {
  if (arm === NO_TOOL) return [];
  const tool = order.tools.find((candidate) => candidate.name === arm);
  const pin = side === null ? tool?.pin : order.sides.find((candidate) => candidate.name === side)?.pin;
  if (tool === undefined || pin === undefined || pin === null) throw new Error(`arm "${arm}" has no pin to install`);
  return [{ name: tool.name, pin }];
};

/** The transcript's SHA-256, or null when there is no file to hash: a harness that crashed may leave none, and that must not lose the run book. */
const sha256OfFile = async (path: string | null): Promise<string | null> => {
  if (path === null) return null;
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
};

export const runOrder = async (options: RunnerOptions): Promise<RunBook> => {
  const { order, taskSet, fleet, adapter, clock } = options;
  const harness = fleet.harnesses.find((candidate) => candidate.name === order.harness);
  if (harness === undefined) throw new Error(`harness ${order.harness} is not in manifest ${fleet.version}`);
  const plan = planOrder(order, taskSet);
  const startDate = clock().toISOString().slice(0, 10);
  let runs: RunRecord[] = [];
  const valid = new Map<string, number>();
  let sequence = 0;
  let voided = false;

  const attemptSlot = async (planned: PlannedRun): Promise<'valid' | 'cap' | 'task-set-changed'> => {
    for (let attempt = 1; sequence < order.runCap; attempt += 1) {
      sequence += 1;
      const runId = `${order.orderId}-${String(sequence).padStart(4, '0')}`;
      const expected: Expected = {
        taskSetVersion: order.taskSetVersion,
        fixtureTag: taskSet.fixtureTag,
        manifestVersion: order.manifestVersion,
        harnessVersion: harness.version,
        modelId: order.modelId,
        toolPins: expectedPins(order, planned.arm, planned.side),
      };
      const request: RunRequest = { runId, sequence, attempt, order, taskId: planned.taskId, category: planned.category, arm: planned.arm, side: planned.side, repeat: planned.repeat, expected };
      const start = clock();
      // An adapter that throws must not lose the run book: the throw is a void run (prepare: the machine, run: the harness) and the slot reruns.
      let prepared: Prepared | null = null;
      let result: RunResult | null = null;
      let thrown: VoidReason | null = null;
      try {
        prepared = await adapter.prepare(request);
      } catch {
        thrown = 'machine-failed';
      }
      try {
        if (prepared !== null) result = await adapter.run(prepared, request);
      } catch {
        thrown = 'harness-failed';
      }
      try {
        let reason = prepared === null || result === null ? thrown : voidReasonOf(expected, prepared, result);
        const transcriptSha256 = await sha256OfFile(result?.transcriptPath ?? null);
        // A run that is valid so far still needs its transcript (the run book hashes it, and the store folder holds it) and its check.
        if (reason === null && transcriptSha256 === null) reason = 'transcript-missing';
        let check: CheckResult | null = null;
        if (reason === null && prepared !== null) {
          try {
            check = await adapter.check(prepared, request);
          } catch {
            reason = 'check-script-failed';
          }
        }
        let sessionId: string | null = null;
        const transcriptPath = result?.transcriptPath ?? null;
        if (reason === null && options.stage !== undefined && transcriptPath !== null) {
          try {
            sessionId = await options.stage(request, transcriptPath);
          } catch {
            reason = 'transcript-missing';
          }
        }
        runs.push({
          runId,
          taskId: planned.taskId,
          category: planned.category,
          arm: planned.arm,
          side: planned.side,
          repeat: planned.repeat,
          harness: harness.name,
          harnessVersion: result?.harnessVersion ?? harness.version,
          provider: harness.provider,
          region: harness.region,
          modelId: result?.modelId ?? order.modelId,
          start: start.toISOString(),
          end: clock().toISOString(),
          check,
          exitStatus: result?.exit.kind ?? 'adapter-threw',
          exitCode: result?.exit.code ?? -1,
          inputTokens: result?.tokens.input ?? 0,
          cacheTokens: result?.tokens.cache ?? 0,
          outputTokens: result?.tokens.output ?? 0,
          transcriptSha256,
          poolSessionId: reason === null ? (sessionId ?? result?.poolSessionId ?? null) : null,
          void: reason,
        });
        if (reason === 'task-set-changed') return 'task-set-changed';
        if (reason === null) return 'valid';
      } finally {
        await prepared?.dispose();
      }
    }
    return 'cap';
  };

  for (const planned of plan.runs) {
    const outcome = await attemptSlot(planned);
    if (outcome === 'task-set-changed') {
      // Spec section 9: a changed task set voids the whole order. Nothing is rerun (a real adapter would change again and burn the cap); a new order on the new version is the buyer's call.
      runs = runs.map((run) => ({ ...run, check: null, poolSessionId: null, void: 'task-set-changed' }));
      valid.clear();
      voided = true;
      break;
    }
    if (outcome === 'cap') break;
    const key = cellKey(planned);
    valid.set(key, (valid.get(key) ?? 0) + 1);
  }

  const shortCells: ShortCell[] = plan.cells
    .map((cell) => ({ taskId: cell.taskId, arm: cell.arm, side: cell.side, have: valid.get(cellKey(cell)) ?? 0, want: order.repeats }))
    .filter((cell) => cell.have < cell.want);

  return {
    header: {
      orderId: order.orderId,
      line: order.line,
      taskSetVersion: order.taskSetVersion,
      manifestVersion: order.manifestVersion,
      fixtureTag: taskSet.fixtureTag,
      fixtureCommit: taskSet.fixtureCommit,
      tools: order.tools,
      arms: order.arms,
      sides: order.sides,
      operator: options.operator,
      repeats: order.repeats,
      runCap: order.runCap,
      startDate,
      endDate: clock().toISOString().slice(0, 10),
      status: voided ? 'voided' : shortCells.length === 0 ? 'complete' : 'incomplete',
      shortCells,
    },
    runs,
  };
};
