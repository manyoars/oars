// A small store for the cell and family tests: only the fields a cell or a read looks at, so a test states the calls and prompts that matter to it.
import { deriveCells, poolOf, type Pool } from './cells.js';
import type { ErrorObservation, Frame, PromptObservation, SessionObservation, StepObservation, ToolObservation, Usage } from './schema.js';
import type { Store } from './store.js';

export const frame = (over: Partial<Frame> = {}): Frame => ({
  harness: 'claude-code',
  harnessVersion: '2.1.314',
  model: 'claude-opus-5-5',
  effort: 'high',
  day: '2026-11-01',
  platform: 'linux',
  shell: 'Bash',
  stack: { languages: [], frameworks: [], size: null },
  ...over,
});

const USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };

export const session = (id: string, over: Partial<SessionObservation> = {}): SessionObservation => ({
  kind: 'session',
  cv: '7',
  sid: 'aaaaaaaa',
  session: id,
  project: 'proj',
  parent: null,
  agentType: null,
  spawnedBy: null,
  rev: 1,
  at: '2026-11-01T00:00:00.000Z',
  bytes: 0,
  lines: 0,
  badLines: 0,
  userTurns: 0,
  assistantTurns: 0,
  tsFirst: null,
  tsLast: null,
  versions: [],
  models: {},
  branches: [],
  tools: {},
  files: [],
  fileHashes: [],
  repo: null,
  urls: [],
  searches: [],
  bashCmds: 0,
  tldrs: [],
  confidences: [],
  compactSummaries: 0,
  promptFingerprint: null,
  env: { harness: '2.1.300', oars: '0.0.0', node: '24', os: 'linux' },
  costUsd: null,
  usage: USAGE,
  ...over,
});

export const prompt = (id: string, index: number, over: Partial<PromptObservation> = {}): PromptObservation => ({
  kind: 'prompt',
  v: '9',
  session: id,
  rev: 1,
  index,
  ts: null,
  wallSec: null,
  head: '',
  cls: 'edit-verify',
  tools: [],
  shape: '',
  errors: 0,
  thinking: 0,
  sideTools: 0,
  turns: 0,
  model: 'claude-opus-5-5',
  efforts: ['high'],
  skills: [],
  usage: USAGE,
  recovery: [],
  explore: 0,
  act: 0,
  bigrams: {},
  contextFingerprint: null,
  frame: frame(),
  ...over,
});

export const tool = (id: string, n: number, name: string, over: Partial<ToolObservation> = {}): ToolObservation => ({
  kind: 'tool',
  cv: '7',
  sid: 'aaaaaaaa',
  session: id,
  rev: 1,
  parent: id,
  agentType: null,
  n,
  ts: null,
  tool: name,
  status: 'ok',
  target: null,
  targetBase: null,
  keys: [],
  durationMs: 10,
  toolUseId: `${id}-${String(n)}`,
  harnessVersion: null,
  side: false,
  prompt: 0,
  ...over,
});

export const store = (over: Partial<Store>): Store => ({ sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0, ...over });

export const step = (n: number, seg: number, action: StepObservation['action'], over: Partial<StepObservation> = {}): StepObservation => ({
  n,
  seg,
  action,
  native: 'tool',
  identity: null,
  status: 'ok',
  cost: { tokens: null, durationMs: null },
  parent: null,
  edges: [],
  frameId: 'f',
  ...over,
});

export const error = (id: string, sig: string, over: Partial<ErrorObservation> = {}): ErrorObservation => ({
  kind: 'error',
  v: '9',
  session: id,
  rev: 1,
  ts: '2026-11-01T10:00:00.000Z',
  harnessVersion: null,
  tool: 'Read',
  sig,
  example: sig,
  next: [],
  editFollowed: false,
  prompt: 0,
  cls: 'edit-verify',
  ...over,
});

/** The pool of a fixture store, for a family test to hand its deriver. */
export const poolFrom = (from: Store): Pool => poolOf(deriveCells(from), from.errors);
