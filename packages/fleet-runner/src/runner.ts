// The runner: walks the plan, runs each slot through the adapter, voids by spec section 9, and reruns a void slot in place (so a retest stays interleaved)
// until every cell has its repeats or the order's run cap is hit. A void run is recorded with its reason and counts against the cap; it is never counted as a repeat.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Expected, HarnessAdapter, Prepared, RunRequest, RunResult, ToolPin } from './harness.js';
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

const sha256OfFile = async (path: string | null): Promise<string | null> => (path === null ? null : createHash('sha256').update(await readFile(path)).digest('hex'));

export const runOrder = async (options: RunnerOptions): Promise<RunBook> => {
  const { order, taskSet, fleet, adapter, clock } = options;
  const harness = fleet.harnesses.find((candidate) => candidate.name === order.harness);
  if (harness === undefined) throw new Error(`harness ${order.harness} is not in manifest ${fleet.version}`);
  const plan = planOrder(order, taskSet);
  const startDate = clock().toISOString().slice(0, 10);
  const runs: RunRecord[] = [];
  const valid = new Map<string, number>();
  let sequence = 0;

  const attemptSlot = async (planned: PlannedRun): Promise<boolean> => {
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
      const prepared = await adapter.prepare(request);
      try {
        const result = await adapter.run(prepared, request);
        const reason = voidReasonOf(expected, prepared, result);
        const check = reason === null ? await adapter.check(prepared, request) : null;
        runs.push({
          runId,
          taskId: planned.taskId,
          category: planned.category,
          arm: planned.arm,
          side: planned.side,
          repeat: planned.repeat,
          harness: harness.name,
          harnessVersion: result.harnessVersion,
          provider: harness.provider,
          region: harness.region,
          modelId: result.modelId,
          start: start.toISOString(),
          end: clock().toISOString(),
          check,
          exitStatus: result.exit.kind,
          exitCode: result.exit.code,
          inputTokens: result.tokens.input,
          cacheTokens: result.tokens.cache,
          outputTokens: result.tokens.output,
          transcriptSha256: await sha256OfFile(result.transcriptPath),
          poolSessionId: result.poolSessionId,
          void: reason,
        });
        if (reason === null) return true;
      } finally {
        await prepared.dispose();
      }
    }
    return false;
  };

  for (const planned of plan.runs) {
    if (!(await attemptSlot(planned))) break;
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
      status: shortCells.length === 0 ? 'complete' : 'incomplete',
      shortCells,
    },
    runs,
  };
};
