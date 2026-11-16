// Shared test data: an 8-task manifest shaped like an order's slice of v1 (six category tasks and the two controls), a fleet manifest, and orders.
import type { FleetManifest, TaskSetManifest } from './manifest.js';

export const FLEET: FleetManifest = {
  version: 'fleet-1',
  harnesses: [{ name: 'claude-code-bedrock', version: '2.1.30', provider: 'bedrock', region: 'us-east-1', modelIds: ['sonnet-pinned-1'] }],
};

export const taskSet = (count = 8): TaskSetManifest => ({
  version: 'v1',
  fixtureTag: 'taskset-v1',
  fixtureCommit: 'abc123',
  tasks: Array.from({ length: count }, (_, index) => ({ id: `t${String(index + 1)}`, category: index < count - 2 ? 'browser' : 'control' })),
});

export interface OrderShape {
  orderId: string;
  line: string;
  taskSetVersion: string;
  manifestVersion: string;
  harness: string;
  modelId: string;
  /** The operator's pool account id: the run book's pool session ids are keyed by it. */
  account: string;
  tools: { name: string; kind: string; pin?: string }[];
  arms: string[];
  sides: { name: string; pin?: string; taskSetVersion?: string }[];
  repeats?: number;
  runCap: number;
}

export const retestShape = (): OrderShape => ({
  orderId: 'o-1',
  line: 'retest',
  taskSetVersion: 'v1',
  manifestVersion: 'fleet-1',
  harness: 'claude-code-bedrock',
  modelId: 'sonnet-pinned-1',
  account: 'acct-fleet',
  tools: [{ name: 'playwright', kind: 'server' }],
  arms: ['playwright'],
  sides: [
    { name: 'before', pin: 'npm:1.0.0' },
    { name: 'after', pin: 'npm:1.1.0' },
  ],
  repeats: 3,
  runCap: 60,
});

export const comparisonShape = (): OrderShape => ({
  orderId: 'o-2',
  line: 'comparison',
  taskSetVersion: 'v1',
  manifestVersion: 'fleet-1',
  harness: 'claude-code-bedrock',
  modelId: 'sonnet-pinned-1',
  account: 'acct-fleet',
  tools: [
    { name: 'playwright', kind: 'server', pin: 'npm:1.0.0' },
    { name: 'sqlite', kind: 'server', pin: 'git:deadbeef' },
  ],
  arms: ['no-tool', 'playwright', 'sqlite'],
  sides: [],
  repeats: 3,
  runCap: 100,
});

export const retestText = (patch: Partial<OrderShape> = {}): string => JSON.stringify({ ...retestShape(), ...patch });
export const comparisonText = (patch: Partial<OrderShape> = {}): string => JSON.stringify({ ...comparisonShape(), ...patch });
