// Turns what a working path knows into event fields: counts and closed words only, built here so the path carries one line and the rule for each field is in one place.
// The schema still checks every value; these functions are what make a value fit it (a private model name becomes `other`, not a dropped field).
import type { Recall } from '../sessions/recall-object.js';
import { HARNESSES, OTHER } from '../sessions/pool-wire.js';
import { modelWord, versionWord } from './schema.js';

/** The harness a hook ran under, as the closed list names it, else `other`. */
export const harnessWord = (harness: string): string => (HARNESSES.some((known) => known === harness) ? harness : OTHER);

/**
 * The harness, harness version, and model a hook saw, as the public vocabulary knows them or `other`; a version or model the hook did not see is absent. A hook fire names its harness (the
 * recall's frame when a push made one); the nightly task runs under none, so its caller passes `undefined` and the event carries no harness (it reads as `unrecorded`).
 */
export const frameWords = (harness: string | undefined, harnessVersion: string | null | undefined, model: string | null | undefined): { harness?: string; harnessVersion?: string; model?: string } => ({
  ...(harness === undefined ? {} : { harness: harnessWord(harness) }),
  ...(harnessVersion === undefined || harnessVersion === null ? {} : { harnessVersion: versionWord(harnessVersion) }),
  ...(model === undefined || model === null ? {} : { model: modelWord(model) }),
});

/** A recall as counts: how it was asked, which families it served, how many reads and evidence rows, the size of the answer, and its arm. Never the query text, a name, or the rendered answer. */
export const recallFields = (recall: Recall, families: readonly string[], legacy = false): object => ({
  form: legacy ? 'legacy' : recall.query.form,
  mode: recall.mode,
  families: [...new Set(families)],
  kind: recall.answer.kind,
  reads: recall.answer.reads.length,
  evidence: recall.evidence.length,
  tokens: recall.answer.tokens,
  arm: recall.arm,
});
