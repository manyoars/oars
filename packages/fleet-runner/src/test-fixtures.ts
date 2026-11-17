// Shared test data: an 8-task manifest shaped like an order's slice of v1 (six category tasks and the two controls), a fleet manifest, and orders.
import { readFileSync } from 'node:fs';
import { type FleetManifest, parseFleet, type TaskSetManifest } from './manifest.js';

// The fleet manifest is the file in the package, so a test and the deposit command read one definition.
export const FLEET: FleetManifest = parseFleet(readFileSync(new URL('../fleet-manifest.json', import.meta.url), 'utf8'));

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
  modelId: 'global.anthropic.claude-sonnet-5-5',
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
  modelId: 'global.anthropic.claude-sonnet-5-5',
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
