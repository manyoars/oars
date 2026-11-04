// The gate policy file: what the hook may say, per class, in a closed vocabulary. The operator writes it; nothing here writes it. A missing file reads as the defaults, and so
// does one that cannot be read or does not fit the shape: the hook never throws over it, and the row records which of the three it was, so `oars gate report` can count them.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The classes the policy sets. Each is something a row can already tell: a registry name first published recently, and a name the registry does not hold. */
export const POLICY_CLASSES = ['young-name', 'not-found'] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

export const POLICY_ACTIONS = ['warn', 'block', 'off'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** What a young name can be set to: a note or nothing. A block is for a name the registry does not hold, since only that is a fact the registry answers by itself. */
const ALLOWED: Readonly<Record<PolicyClass, readonly PolicyAction[]>> = { 'young-name': ['warn', 'off'], 'not-found': POLICY_ACTIONS };

export interface Policy {
  classes: Readonly<Record<PolicyClass, PolicyAction>>;
  /** A name first published fewer days ago than this is a young name. */
  youngDays: number;
  /** The share, 0 to 100, of notes that would show and do not. Never applied to a block. */
  holdbackPercent: number;
}

export const DEFAULT_POLICY: Policy = { classes: { 'young-name': 'warn', 'not-found': 'warn' }, youngDays: 30, holdbackPercent: 10 };

/** Where a row's policy came from: no file, a file that fit, or a file that was there and did not (so the defaults stood). */
export const POLICY_SOURCES = ['default', 'file', 'invalid'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

export interface PolicyRead {
  policy: Policy;
  source: PolicySource;
}

export const policyPath = (storeDir: string): string => join(storeDir, 'gate-policy.json');

const KEYS: ReadonlySet<string> = new Set(['v', 'classes', 'youngDays', 'holdbackPercent']);

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

const integerIn = (value: unknown, low: number, high: number): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : undefined);

/** `undefined` for anything outside the closed vocabulary: an unknown key, class, or action, a number out of range, or another version. */
const fit = (parsed: unknown): Policy | undefined => {
  if (!isObject(parsed) || Object.keys(parsed).some((key) => !KEYS.has(key))) return undefined;
  const version: unknown = Reflect.get(parsed, 'v');
  if (version !== undefined && version !== 1) return undefined;
  const given: unknown = Reflect.get(parsed, 'classes');
  if (given !== undefined && (!isObject(given) || Object.keys(given).some((key) => !POLICY_CLASSES.some((known) => known === key)))) return undefined;
  const classes = { ...DEFAULT_POLICY.classes };
  for (const cls of POLICY_CLASSES) {
    const action: unknown = isObject(given) ? Reflect.get(given, cls) : undefined;
    if (action === undefined) continue;
    const allowed = ALLOWED[cls].find((one) => one === action);
    if (allowed === undefined) return undefined;
    classes[cls] = allowed;
  }
  const days: unknown = Reflect.get(parsed, 'youngDays');
  const share: unknown = Reflect.get(parsed, 'holdbackPercent');
  const youngDays = days === undefined ? DEFAULT_POLICY.youngDays : integerIn(days, 1, 365);
  const holdbackPercent = share === undefined ? DEFAULT_POLICY.holdbackPercent : integerIn(share, 0, 100);
  return youngDays === undefined || holdbackPercent === undefined ? undefined : { classes, youngDays, holdbackPercent };
};

/** Never throws. A file that is not there is the defaults; one that is there and cannot be read or does not fit is the defaults too, and says `invalid`. */
export const loadPolicy = async (storeDir: string): Promise<PolicyRead> => {
  let body: string;
  try {
    body = await readFile(policyPath(storeDir), 'utf8');
  } catch (error) {
    const code: unknown = isObject(error) ? Reflect.get(error, 'code') : undefined;
    return { policy: DEFAULT_POLICY, source: code === 'ENOENT' ? 'default' : 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { policy: DEFAULT_POLICY, source: 'invalid' };
  }
  const policy = fit(parsed);
  return policy === undefined ? { policy: DEFAULT_POLICY, source: 'invalid' } : { policy, source: 'file' };
};

/** What `oars gate policy` prints. */
export const formatPolicy = (read: PolicyRead, file: string): string => {
  const origin =
    read.source === 'file' ? `Policy in force: ${file}` : read.source === 'default' ? `Policy in force: defaults (no file at ${file})` : `Policy in force: defaults (${file} is unreadable or invalid, so it is ignored)`;
  return [
    origin,
    ...POLICY_CLASSES.map((cls) => `${cls}: ${read.policy.classes[cls]}`),
    `Young name: first published within ${String(read.policy.youngDays)} days`,
    `Holdback: ${String(read.policy.holdbackPercent)}% of notes are not shown`,
  ].join('\n');
};
