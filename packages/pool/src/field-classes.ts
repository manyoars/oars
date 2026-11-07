// The pool's class table: one row per field a format 3 batch carries, naming how the pool treats its value. `docs/pool.md`'s wire field register carries the same classes and `field-classes.test.ts` keeps the two equal.
// A class changes by a deploy of this file, never by a client release: the client redacts and sends every other value as it is (`wireName` in `pool-wire.ts`).

/**
 * `clear`: a closed list or an opaque client hash, served as it is. `thresholded`: held always and served only once `K_CELL` distinct accounts report the same value (`PUBLIC_FLOOR` replaces it when t888 lands).
 * `hashed at ingest`: replaced by an HMAC-SHA-256 under `INGEST_HASH_KEY` before anything is written. `raw tier`: stored, never served.
 */
export type FieldClass = 'clear' | 'thresholded' | 'hashed at ingest' | 'raw tier';

/** A field's class, and `longTail` when a value off the public list takes another class than a value on it. */
export interface FieldRow {
  readonly class: FieldClass;
  readonly longTail?: FieldClass;
}

export const FIELD_CLASSES: { readonly [field: string]: FieldRow } = {
  action: { class: 'clear' },
  agentType: { class: 'clear' },
  cacheRead: { class: 'clear' },
  cacheWrite: { class: 'clear' },
  change: { class: 'clear' },
  cls: { class: 'clear' },
  day: { class: 'clear' },
  deltaKind: { class: 'clear' },
  deltas: { class: 'clear' },
  durationMs: { class: 'clear' },
  edges: { class: 'clear' },
  editFollowed: { class: 'clear' },
  effort: { class: 'clear' },
  errorCode: { class: 'clear' },
  errors: { class: 'clear' },
  explore: { class: 'clear' },
  field: { class: 'clear' },
  fieldsVersion: { class: 'clear' },
  filled: { class: 'clear' },
  flags: { class: 'clear', longTail: 'thresholded' },
  format: { class: 'clear' },
  frame: { class: 'clear' },
  frames: { class: 'clear' },
  frameworks: { class: 'clear' },
  harness: { class: 'clear' },
  harnessVersion: { class: 'clear' },
  host: { class: 'hashed at ingest' },
  id: { class: 'clear' },
  identity: { class: 'clear' },
  input: { class: 'clear' },
  kind: { class: 'clear' },
  language: { class: 'clear' },
  languageShare: { class: 'clear' },
  languageShares: { class: 'clear' },
  languages: { class: 'clear' },
  leaves: { class: 'clear' },
  mcp: { class: 'clear', longTail: 'thresholded' },
  merkleRoot: { class: 'clear' },
  metric: { class: 'clear' },
  model: { class: 'clear' },
  ms: { class: 'clear' },
  name: { class: 'clear', longTail: 'thresholded' },
  native: { class: 'clear', longTail: 'thresholded' },
  next: { class: 'clear' },
  output: { class: 'clear' },
  parent: { class: 'clear' },
  platform: { class: 'clear' },
  plugins: { class: 'clear' },
  program: { class: 'clear', longTail: 'thresholded' },
  prompt: { class: 'clear' },
  prompts: { class: 'clear' },
  pulls: { class: 'clear' },
  reach: { class: 'clear' },
  recoveryCalls: { class: 'clear' },
  registry: { class: 'clear' },
  remainingTokens: { class: 'clear' },
  server: { class: 'clear', longTail: 'thresholded' },
  shell: { class: 'clear' },
  side: { class: 'clear' },
  size: { class: 'clear' },
  skill: { class: 'clear', longTail: 'thresholded' },
  skills: { class: 'clear', longTail: 'thresholded' },
  spawnedIn: { class: 'clear' },
  stack: { class: 'clear' },
  status: { class: 'clear' },
  steps: { class: 'clear' },
  sub: { class: 'clear', longTail: 'thresholded' },
  target: { class: 'clear' },
  thinking: { class: 'clear' },
  timingPrint: { class: 'clear' },
  tokens: { class: 'clear' },
  tool: { class: 'clear', longTail: 'thresholded' },
  tools: { class: 'clear' },
  transcripts: { class: 'clear' },
  usage: { class: 'clear' },
  version: { class: 'clear', longTail: 'thresholded' },
  vocabVersion: { class: 'clear' },
  wallSec: { class: 'clear' },
};

/** The class of a field, or undefined when the table has no row for it (a field the client emits with no row fails `field-classes.test.ts`). */
export const classOf = (field: string): FieldRow | undefined => (Object.hasOwn(FIELD_CLASSES, field) ? FIELD_CLASSES[field] : undefined);
