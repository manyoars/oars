// What the tests above order 1 share: tool calls in bulk, and the order 1 reads of a fixture store, so a test plants counts and reads relations.
import { deriveFirstOrder } from './pool.js';
import { poolFrom, tool } from './pool-fixture.js';
import type { Read } from './read.js';
import type { ToolObservation } from './schema.js';
import type { Store } from './store.js';

let next = 0;

/** `count` calls of each named tool in one prompt. The first `failed` of each come back with an error. */
export const tools = (session: string, promptIndex: number, calls: readonly { name: string; count: number }[], failed = 0): ToolObservation[] =>
  calls.flatMap(({ name, count }) =>
    Array.from({ length: count }, (_, index) => {
      next += 1;
      return tool(session, next, name, { prompt: promptIndex, status: index < failed ? 'error' : 'ok' });
    }),
  );

export const firstOrderOf = (from: Store): Read[] => deriveFirstOrder(poolFrom(from), from);
