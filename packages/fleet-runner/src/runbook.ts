// The run book (spec section 7): a header line, then one line per run, as JSON Lines. Keys are written in the order the record literals below list them, so the same
// runs always give the same bytes. It holds no transcript text and carries no signature: the sign step is a later brief (`ssh-keygen -Y sign` over the finished file).
import type { CheckResult } from './harness.js';

export type VoidReason =
  | 'harness-failed'
  | 'sign-in-lost'
  | 'task-set-changed'
  | 'fixture-tag-changed'
  | 'manifest-changed'
  | 'harness-version-changed'
  | 'model-changed'
  | 'tool-pin-mismatch'
  | 'machine-failed';

export interface ShortCell {
  taskId: string;
  arm: string;
  side: string | null;
  have: number;
  want: number;
}

export interface RunBookHeader {
  orderId: string;
  line: string;
  taskSetVersion: string;
  manifestVersion: string;
  fixtureTag: string;
  fixtureCommit: string;
  tools: { name: string; kind: string; pin: string | null }[];
  arms: string[];
  sides: { name: string; pin: string }[];
  operator: string;
  repeats: number;
  runCap: number;
  startDate: string;
  endDate: string;
  /** `complete` when every cell has its repeats; `incomplete` when the run cap ended the order first; `voided` when the task set changed mid-order (every run is void, none rerun, and `shortCells` lists every planned cell with 0 valid runs). */
  status: 'complete' | 'incomplete' | 'voided';
  shortCells: ShortCell[];
}

export interface RunRecord {
  runId: string;
  taskId: string;
  category: string;
  arm: string;
  side: string | null;
  repeat: number;
  harness: string;
  harnessVersion: string;
  provider: string;
  region: string;
  modelId: string;
  start: string;
  end: string;
  /** Null for a void run: its check is not read. */
  check: CheckResult | null;
  exitStatus: string;
  exitCode: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  transcriptSha256: string | null;
  poolSessionId: string | null;
  void: VoidReason | null;
}

export interface RunBook {
  header: RunBookHeader;
  runs: RunRecord[];
}

// Each literal fixes the key order of its line.
const headerLine = (h: RunBookHeader): RunBookHeader => ({
  orderId: h.orderId,
  line: h.line,
  taskSetVersion: h.taskSetVersion,
  manifestVersion: h.manifestVersion,
  fixtureTag: h.fixtureTag,
  fixtureCommit: h.fixtureCommit,
  tools: h.tools.map((tool) => ({ name: tool.name, kind: tool.kind, pin: tool.pin })),
  arms: h.arms,
  sides: h.sides.map((side) => ({ name: side.name, pin: side.pin })),
  operator: h.operator,
  repeats: h.repeats,
  runCap: h.runCap,
  startDate: h.startDate,
  endDate: h.endDate,
  status: h.status,
  shortCells: h.shortCells.map((cell) => ({ taskId: cell.taskId, arm: cell.arm, side: cell.side, have: cell.have, want: cell.want })),
});

const runLine = (r: RunRecord): RunRecord => ({
  runId: r.runId,
  taskId: r.taskId,
  category: r.category,
  arm: r.arm,
  side: r.side,
  repeat: r.repeat,
  harness: r.harness,
  harnessVersion: r.harnessVersion,
  provider: r.provider,
  region: r.region,
  modelId: r.modelId,
  start: r.start,
  end: r.end,
  check: r.check,
  exitStatus: r.exitStatus,
  exitCode: r.exitCode,
  inputTokens: r.inputTokens,
  cacheTokens: r.cacheTokens,
  outputTokens: r.outputTokens,
  transcriptSha256: r.transcriptSha256,
  poolSessionId: r.poolSessionId,
  void: r.void,
});

export const serializeRunBook = (book: RunBook): string => `${[headerLine(book.header), ...book.runs.map(runLine)].map((line) => JSON.stringify(line)).join('\n')}\n`;
