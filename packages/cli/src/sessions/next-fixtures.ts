// Shared fixtures for the next-node read tests (t926): a typed read, the text a hook injected, and the pool version a staged index carries.
import { readFileSync } from 'node:fs';
import { indexPath } from './hook-index.js';
import type { Read } from './read.js';

/** A read with only the fields the next-node code looks at set; the rest are inert defaults. */
export const readOf = (over: Partial<Read>): Read => ({
  readId: 'read:0000000000000000',
  family: 'recovery',
  method: 'fixture',
  methodVersion: '1',
  inputs: ['cell:0000000000000000'],
  order: 1,
  slice: {},
  value: {},
  n: 0,
  clusters: 1,
  interval: null,
  asOf: { pool: 'p', day: '2026-11-01' },
  basis: 'all',
  ...over,
});

/** The `additionalContext` of a hook's output; empty when it printed nothing. */
export const contextOf = (output: string | undefined): string => {
  const parsed: unknown = JSON.parse(output ?? '{}');
  const inner: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'hookSpecificOutput') : undefined;
  const text: unknown = typeof inner === 'object' && inner !== null ? Reflect.get(inner, 'additionalContext') : undefined;
  return typeof text === 'string' ? text : '';
};

/** The pool version (`at`) of the index staged in a store. */
export const indexAtOf = (storeDir: string): string => {
  const parsed: unknown = JSON.parse(readFileSync(indexPath(storeDir), 'utf8'));
  const at: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'at') : undefined;
  return typeof at === 'string' ? at : '';
};
