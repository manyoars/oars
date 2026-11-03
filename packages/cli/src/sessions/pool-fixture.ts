// A small store for the cell and family tests: only the fields a cell or a read looks at, so a test states the calls and prompts that matter to it.
import type { Frame, PromptObservation, SessionObservation, ToolObservation, Usage } from './schema.js';
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
  rev: 1,
  parent: null,
  models: {},
  env: { harness: '2.1.300', oars: '0.0.0', node: '24', os: 'linux' },
  tsFirst: null,
  ...over,
} as SessionObservation);

export const prompt = (id: string, index: number, over: Partial<PromptObservation> = {}): PromptObservation => ({
  kind: 'prompt',
  session: id,
  index,
  ts: null,
  wallSec: null,
  cls: 'edit-verify',
  model: 'claude-opus-5-5',
  efforts: ['high'],
  errors: 0,
  usage: USAGE,
  frame: frame(),
  ...over,
} as PromptObservation);

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
