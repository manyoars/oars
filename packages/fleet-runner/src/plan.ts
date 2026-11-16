// The plan: a pure function from an order and a task-set manifest to the ordered runs and the cells they fill (spec sections 5 and 6).
// A cell is one task, one arm, and one side; it needs `repeats` valid runs. A retest alternates sides inside each repeat (task 1 before, task 1 after, ...)
// so drift in the harness or model hits both sides alike.
import type { Order } from './order.js';
import type { TaskSetManifest } from './manifest.js';

export interface Cell {
  taskId: string;
  category: string;
  arm: string;
  /** The retest side's name; null in a comparison. */
  side: string | null;
}

export interface PlannedRun extends Cell {
  /** 1-based valid-run number inside the cell. */
  repeat: number;
}

export interface Plan {
  cells: Cell[];
  runs: PlannedRun[];
}

export const cellKey = (cell: Cell): string => `${cell.taskId}|${cell.arm}|${cell.side ?? ''}`;

export const planOrder = (order: Order, taskSet: TaskSetManifest): Plan => {
  if (order.taskSetVersion !== taskSet.version) throw new Error(`order names task set ${order.taskSetVersion} but the manifest is ${taskSet.version}`);
  const sides: (string | null)[] = order.sides.length === 0 ? [null] : order.sides.map((side) => side.name);
  const cells: Cell[] = [];
  const runs: PlannedRun[] = [];
  for (const task of taskSet.tasks) {
    for (const arm of order.arms) {
      for (const side of sides) cells.push({ taskId: task.id, category: task.category, arm, side });
      for (let repeat = 1; repeat <= order.repeats; repeat += 1) {
        for (const side of sides) runs.push({ taskId: task.id, category: task.category, arm, side, repeat });
      }
    }
  }
  return { cells, runs };
};
