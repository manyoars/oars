// The recall object (recall spec Section 2.7): one event in the asker's graph, with edges back to the evidence it drew on and forward to what the asker
// did next. A pull and a push are the same object, and both land in `recalls.jsonl`, append-only, whether or not anything was injected.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame } from './schema.js';

const RECALLS_FILE = 'recalls.jsonl';

export const recallsPath = (storeDir: string): string => join(storeDir, RECALLS_FILE);

/** The share of pushes held back (spec Section 8, open parameter). */
export const HOLDBACK_RATE = 0.1;

export const RECALL_CLASSES = {
  A: ['sid', 'at', 'query.text'],
  P: ['id', 'n', 'frame', 'mode', 'query.form', 'query.prefix', 'query.entity', 'query.family', 'query.slice', 'poolVersion', 'arm', 'answer', 'evidence', 'consequence'],
} as const;

export type RecallMode = 'pull' | 'push';
export type RecallArm = 'shown' | 'held';
export type RecallForm = 'pattern' | 'entity' | 'question' | 'text';

/** Which frames a read covers. Each name is held to the public vocabulary before it is shown. */
export interface RecallSlice {
  harnessVersion?: string;
  model?: string;
  tool?: string;
  cls?: string;
  sinceDays?: number;
  /** The read family's own scope, a closed name such as `repository`. */
  scope?: string;
}

export interface RecallQueryObject {
  form: RecallForm;
  /** Motif IDs for the asker's steps so far. Read IDs stand in until the motif file lands. */
  prefix?: string[];
  /** A public name: package, tool, MCP server, or model. */
  entity?: string;
  family?: string;
  slice?: RecallSlice;
  /** Class A, local only. */
  text?: string;
}

export interface RecallAnswer {
  kind: 'hit' | 'miss';
  /** Read IDs, in the order shown. */
  reads: string[];
  /** The size of what was injected, or of what a held recall would have injected. */
  tokens: number;
  /** What the asker saw, or for a held recall would have seen. It holds structured fields only (`recall-render.ts`). */
  rendered: string;
  /** The closed names a follow can match: canonical actions, in the order shown. */
  names: string[];
}

export type DeltaAxis = 'same' | 'differs' | 'unknown';

/** How far the evidence sits from the asker, per axis, never collapsed into a score (spec Section 3). */
export interface RecallDelta {
  harness: DeltaAxis;
  /** The asker's version minus the evidence's newest, when only the last component differs; null when that does not read as a count. */
  harnessVersions: number | null;
  model: DeltaAxis;
  /** How many of the evidence's models are not the asker's; null when the asker's is unknown. */
  modelVersions: number | null;
  platform: DeltaAxis;
  shell: DeltaAxis;
  stack: DeltaAxis;
  /** No record states a tool's version yet. */
  toolVersion: number | null;
  ageDays: number | null;
}

export interface FrameRange {
  harnesses: string[];
  harnessVersions: string[];
  models: string[];
}

export interface RecallEvidence {
  /** A read, cell, or recall ID. Never another account's session. */
  ref: string;
  frameRange: FrameRange;
  firstDay: string | null;
  lastDay: string | null;
  n: number;
  clusters: number;
  delta: RecallDelta;
}

/** The outcome signals of the window's prompt, held separately: no composite (spec Section 2.7). */
export interface RecallOutcome {
  errors: number | null;
  verify: string | null;
  stopped: string | null;
  commits: number | null;
  redo: boolean | null;
}

/** Derived from the capture records, never captured live. */
export interface RecallConsequence {
  /** The calls the window holds, by position, and why it ended. */
  window: { from: number; to: number; calls: number; end: 'prompt' | 'calls' | 'session' };
  motifs: string[];
  followed: boolean;
  /** `tokens` is null when no call in the window measured any: an older capture has no step costs, and zero would read as a free window. */
  cost: { tokens: number | null; durationMs: number };
  outcome: RecallOutcome;
}

export interface Recall {
  id: string;
  /** The session the asker ran in; null for a pull made outside one, which no consequence can be read for. Class A. */
  sid: string | null;
  /** Class A. */
  at: string;
  /** The asker's position among its calls. A hook cannot know it without reading the transcript, so derive fills it from `at`. */
  n: number | null;
  frame: Frame | null;
  mode: RecallMode;
  query: RecallQueryObject;
  /** The snapshot answered from: the deposit time of the store or index, so "older than the recall" is a comparison. */
  poolVersion: string;
  arm: RecallArm;
  answer: RecallAnswer;
  evidence: RecallEvidence[];
  consequence?: RecallConsequence;
}

/** Characters per token, the rule of thumb: the size is a count for comparing arms, not a bill. */
const CHARS_PER_TOKEN = 4;

const hash = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export interface RecallInput {
  sid: string | null;
  at: string;
  frame: Frame | null;
  mode: RecallMode;
  query: RecallQueryObject;
  poolVersion: string;
  arm: RecallArm;
  reads: readonly string[];
  rendered: string;
  names: readonly string[];
  evidence: readonly RecallEvidence[];
}

export const makeRecall = (input: RecallInput): Recall => ({
  id: hash([input.sid, input.at, input.mode, input.query, input.poolVersion]).slice(0, 16),
  sid: input.sid,
  at: input.at,
  n: null,
  frame: input.frame,
  mode: input.mode,
  query: input.query,
  poolVersion: input.poolVersion,
  arm: input.arm,
  answer: {
    kind: input.reads.length === 0 ? 'miss' : 'hit',
    reads: [...input.reads],
    tokens: Math.ceil(input.rendered.length / CHARS_PER_TOKEN),
    rendered: input.rendered,
    names: [...input.names],
  },
  evidence: [...input.evidence],
});

const SCALE = 0x1_0000_0000;

/** `held` for the hash's first 32 bits under the rate. One session asking from one prefix against one pool always lands on one arm. */
export const armOf = (sid: string, prefix: readonly string[], poolVersion: string, rate = HOLDBACK_RATE): RecallArm =>
  Number.parseInt(hash([sid, prefix, poolVersion]).slice(0, 8), 16) / SCALE < rate ? 'held' : 'shown';

/** Evidence must come from a pool older than the recall (spec Section 3): that one rule is why the commons holds no cycles. */
export const evidencePredates = (recall: Recall): boolean => {
  const day = recall.at.slice(0, 10);
  return recall.poolVersion <= recall.at && recall.evidence.every((item) => item.lastDay === null || item.lastDay <= day);
};

export const appendRecall = async (storeDir: string, recall: Recall): Promise<void> => {
  await mkdir(storeDir, { recursive: true });
  await appendFile(recallsPath(storeDir), `${JSON.stringify(recall)}\n`, { mode: 0o600 });
};

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file is ours, so a line's shape is checked only as far as telling a recall from a torn or foreign line. */
const isRecall = (value: unknown): value is Recall => isRecord(value) && typeof value.id === 'string' && typeof value.at === 'string' && isRecord(value.answer) && isRecord(value.query);

export const parseRecalls = (text: string): Recall[] => {
  const recalls: Recall[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecall(parsed)) recalls.push(parsed);
    } catch {
      // A torn line is skipped.
    }
  }
  return recalls;
};

export const readRecalls = async (storeDir: string): Promise<Recall[]> => {
  let text = '';
  try {
    text = await readFile(recallsPath(storeDir), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return parseRecalls(text);
};
