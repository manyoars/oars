// What an agent reads from a recall. Answers render from structured fields only (spec Section 3): every name passes a closed test and the rest is numbers, so
// error text and other authored strings stay out of an agent's context, whatever a store's records hold.
import { ACTION_TABLES, actionOf, CANONICAL_ACTIONS } from './actions.js';
import { LITERAL, PUBLIC_MCP_SERVERS, publicModel, publicVersion } from './public-vocabulary.js';
import type { RecallDelta, RecallEvidence } from './recall-object.js';
import type { RecallRead } from './recall-reads.js';
import { PROMPT_CLASSES, type Frame, type Harness } from './schema.js';

const DAY_MS = 86_400_000;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,25}$/;
const KEY_WORD_BREAK = /_+|(?<=[a-z0-9])(?=[A-Z])/;
const MAX_KEY_WORDS = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const READ_ID = /^(read:)?[0-9a-f]{16}$/;

/**
 * An input key is an identifier of at most three words: in a scan of real tool rows, 390 of 406 distinct keys were, `run_in_background` and `dangerouslyDisableSandbox` among them.
 * Any longer and an identifier can say a whole instruction. A rare longer key is only left off the line; the shape's ID still holds it.
 */
const isKeyName = (key: string): boolean => KEY_NAME.test(key) && key.split(KEY_WORD_BREAK).filter((word) => word !== '').length <= MAX_KEY_WORDS;

/** A public name as it stands: a model, a canonical action, a tool a harness's table lists, or a published MCP server. Anything else is what the asker or a record wrote. */
export const closedName = (name: string): string => {
  const isPublic = publicModel(name) === name || CANONICAL_ACTIONS.some((action) => action === name) || Object.values(ACTION_TABLES).some((table) => Object.hasOwn(table.rows, name)) || PUBLIC_MCP_SERVERS.has(name);
  return isPublic ? name : LITERAL;
};

const known = (value: string | null | undefined): value is string => value !== null && value !== undefined && value !== LITERAL;

const harnessName = (name: string): string | null => (Object.hasOwn(ACTION_TABLES, name) ? name : null);

const publicDay = (day: string | null): string | null => (day !== null && DAY.test(day) ? day : null);

const versionParts = (version: string): number[] | undefined => {
  const parts = version.split('.').map(Number);
  return parts.every((part) => Number.isInteger(part)) ? parts : undefined;
};

/** The gap in the last component when every other component agrees; undefined when the two do not line up as one count, which an agent must not read as near. */
const lastGap = (asker: string, evidence: string): number | undefined => {
  const mine = versionParts(asker);
  const theirs = versionParts(evidence);
  if (mine === undefined || theirs === undefined || mine.length !== theirs.length) return undefined;
  const last = mine.length - 1;
  if (mine.slice(0, last).some((part, index) => part !== theirs[index])) return undefined;
  return (mine[last] ?? 0) - (theirs[last] ?? 0);
};

const newest = (versions: readonly string[]): string | undefined => versions.flatMap((version) => (versionParts(version) === undefined ? [] : [version])).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();

const axis = (asker: string | null | undefined, evidence: readonly string[]): RecallDelta['harness'] => {
  if (!known(asker) || evidence.length === 0) return 'unknown';
  return evidence.includes(asker) ? 'same' : 'differs';
};

/** What a delta reads of the asker. A pull from outside any known session knows only the day: naming a harness for it would read as `same`, a guess. */
export type RecallAsker = Pick<Frame, 'harnessVersion' | 'model' | 'day'> & { harness: Harness | null };

export const deltaOf = (asker: RecallAsker | null, read: RecallRead): RecallDelta => {
  const version = asker?.harnessVersion;
  const latest = newest(read.harnessVersions);
  const model = axis(asker?.model, read.models);
  const lastDay = publicDay(read.lastDay);
  const today = publicDay(asker?.day ?? null);
  return {
    harness: axis(asker?.harness, read.harnesses),
    harnessVersions: known(version) && latest !== undefined ? (lastGap(version, latest) ?? null) : null,
    model,
    modelVersions: model === 'unknown' ? null : read.models.filter((name) => name !== asker?.model).length,
    // A cell's frame bucket holds no platform, shell, or stack, so a read cannot state them: unknown, never a guess of `same`.
    platform: 'unknown',
    shell: 'unknown',
    stack: 'unknown',
    toolVersion: null,
    ageDays: lastDay === null || today === null ? null : Math.round((Date.parse(today) - Date.parse(lastDay)) / DAY_MS),
  };
};

const closedNames = (values: readonly string[], isPublic: (value: string) => string | null): string[] =>
  values.flatMap((value) => {
    const name = isPublic(value);
    return known(name) ? [name] : [];
  });

/** A class P row an agent also reads over MCP, so its names pass the same closed tests a rendered answer does, and a value they refuse is dropped. */
export const evidenceOf = (read: RecallRead, asker: RecallAsker | null): RecallEvidence => ({
  ref: READ_ID.test(read.readId) ? read.readId : LITERAL,
  frameRange: { harnesses: closedNames(read.harnesses, harnessName), harnessVersions: closedNames(read.harnessVersions, publicVersion), models: closedNames(read.models, publicModel) },
  firstDay: publicDay(read.firstDay),
  lastDay: publicDay(read.lastDay),
  n: read.n,
  clusters: read.clusters,
  delta: deltaOf(asker, read),
});

export const count = (value: number, noun: string): string => `${String(value)} ${noun}${value === 1 ? '' : 's'}`;

/** A range of public versions, newest last; a version the vocabulary refuses is dropped, never shown. */
const versionRange = (versions: readonly string[]): string => {
  const shown = closedNames(versions, publicVersion);
  if (shown.length === 0) return 'version unknown';
  const sorted = [...shown].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const [first] = sorted;
  const last = sorted[sorted.length - 1];
  return first === last ? String(first) : `${String(first)}-${String(last)}`;
};

const modelsOf = (models: readonly string[]): string => {
  const shown = closedNames(models, publicModel);
  return shown.length === 0 ? 'model unknown' : shown.join(', ');
};

const signed = (value: number): string => (value > 0 ? `+${String(value)}` : String(value));

const distance = (delta: RecallDelta): string => {
  const harness = delta.harness !== 'same' ? delta.harness : delta.harnessVersions === null ? 'same, version gap unknown' : delta.harnessVersions === 0 ? 'same' : signed(delta.harnessVersions);
  const age = delta.ageDays === null ? 'unknown' : count(delta.ageDays, 'day');
  return `from you: harness ${harness}, model ${delta.model}, age ${age}`;
};

const isCanonical = (name: string): boolean => CANONICAL_ACTIONS.some((action) => action === name);

/** What a native tool is to the harnesses a read ran under: the first table that lists it, else what any of them can say of it. A read naming no harness asks every table. */
const toolOf = (read: RecallRead, tool: string): { action: string; native: string } => {
  const tables = Object.entries(ACTION_TABLES).filter(([name]) => read.harnesses.includes(name));
  const said = (tables.length === 0 ? Object.values(ACTION_TABLES) : tables.map(([, table]) => table)).map((table) => actionOf(table, tool));
  return said.find((entry) => entry.native !== LITERAL) ?? said.find((entry) => entry.action !== 'other') ?? { action: 'other', native: LITERAL };
};

/** A stored motif read's name: its class, or its canonical steps without their identities. Undefined for a name that is neither, such as a native tool. */
const motifOf = (tool: string): string | undefined => {
  if (PROMPT_CLASSES.some((cls) => cls === tool)) return tool;
  const steps = tool.split('>').map((step) => step.replace(/\[.*$/, ''));
  return steps.every(isCanonical) ? steps.join('>') : undefined;
};

const nameOf = (read: RecallRead): string => {
  // An entity read is about the name itself, which need not be a tool: `actionOf` would read a model or a server as `other`, naming nothing.
  if (read.family === 'entity') return closedName(read.tool);
  const motif = motifOf(read.tool);
  if (motif !== undefined) return motif;
  const { action, native } = toolOf(read, read.tool);
  const name = native === LITERAL ? action : native;
  const keys = read.keys.filter(isKeyName);
  return keys.length === 0 ? name : `${name} [${keys.join(', ')}]`;
};

/** Several tools can sit behind one action, and the same word twice would read as two things, so each action is stated once with the sum. A next-step read already states actions. */
const followedActions = (read: RecallRead): Array<[string, number]> => {
  const sums = new Map<string, number>();
  for (const [tool, times] of read.followed) {
    const action = isCanonical(tool) ? tool : toolOf(read, tool).action;
    sums.set(action, (sums.get(action) ?? 0) + times);
  }
  return [...sums].sort((a, b) => b[1] - a[1]);
};

/** What a read with no denominator counts. A model is not called: its entity read counts the transcript lines that requested it. */
const nounOf = (read: RecallRead): string => {
  if (read.family === 'entity') return read.models.includes(read.tool) ? 'request' : 'call';
  if (read.family === 'next-step') return 'call';
  return read.family === 'recovery' || read.family === 'fit' ? 'error' : 'observation';
};

const line = (read: RecallRead, asker: RecallAsker | null): { text: string; names: string[] } => {
  const followed = followedActions(read);
  const failures = read.calls === null ? count(read.count, nounOf(read)) : `failed ${String(read.count)} of ${count(read.calls, 'call')}`;
  const harnesses = read.harnesses.flatMap((name) => harnessName(name) ?? []);
  const lastDay = publicDay(read.lastDay) ?? 'unknown';
  const id = READ_ID.test(read.readId) ? read.readId : LITERAL;
  const parts = [
    `${nameOf(read)} | ${failures}, ${count(read.n, 'session')}, ${count(read.clusters, 'cluster')} | ${harnesses.join(', ') || 'harness unknown'} ${versionRange(read.harnessVersions)}, ${modelsOf(read.models)}, last ${lastDay}`,
    `  ${distance(deltaOf(asker, read))}`,
    ...(followed.length === 0 ? [] : [`  then: ${followed.map(([action, times]) => `${action} x${String(times)}`).join(', ')}`]),
    `  read ${id} (${read.family})`,
  ];
  return { text: parts.join('\n'), names: followed.map(([action]) => action) };
};

const PREAMBLE = 'oars recall, counts from earlier sessions:';

export const renderAnswer = (reads: readonly RecallRead[], asker: RecallAsker | null): { rendered: string; names: string[] } => {
  if (reads.length === 0) return { rendered: '', names: [] };
  const lines = reads.map((read) => line(read, asker));
  return { rendered: [PREAMBLE, ...lines.map((entry) => entry.text)].join('\n'), names: [...new Set(lines.flatMap((entry) => entry.names))] };
};

/** The text for a miss: what was asked for is left out, because the asker wrote it. */
export const MISS_TEXT = 'oars recall: no answer in the local store.';
