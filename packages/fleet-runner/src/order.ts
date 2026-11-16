// The order file (spec section 10, item 1): what one commissioned run executes. `parseOrder` checks it against the fleet manifest and rejects what the spec forbids:
// a comparison that mixes task-set versions, a retest without exactly two pinned sides, a harness the manifest does not name, and repeats under 1.
import { arrayAt, objectAt, optionalStringAt, parseJson, ParseError, stringAt, type JsonObject } from './json.js';
import type { FleetManifest } from './manifest.js';

export type Line = 'retest' | 'comparison';
export type ToolKind = 'server' | 'skill';

/** The arm that installs nothing; in a comparison it is the control for the category's tasks. */
export const NO_TOOL = 'no-tool';

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  /** An npm version, a git commit, or an image digest. Required in a comparison; a retest pins per side. */
  pin: string | null;
}

export interface SideSpec {
  name: string;
  pin: string;
}

export interface Order {
  orderId: string;
  line: Line;
  taskSetVersion: string;
  manifestVersion: string;
  harness: string;
  modelId: string;
  /** The operator's pool account id: each valid run's pool session id is `contentHash([account, harness session])`, the id the CLI's deposit gives that account and session. */
  account: string;
  tools: ToolSpec[];
  /** `no-tool` or a tool's name. */
  arms: string[];
  /** Two for a retest, none for a comparison. */
  sides: SideSpec[];
  repeats: number;
  runCap: number;
}

const DEFAULT_REPEATS = 3;

const lineOf = (root: JsonObject): Line => {
  const line = stringAt(root, 'line', 'order');
  if (line !== 'retest' && line !== 'comparison') throw new ParseError('order.line must be "retest" or "comparison"');
  return line;
};

const positiveInt = (root: JsonObject, key: string, fallback: number | undefined): number => {
  const value = root[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ParseError(`order.${key} must be an integer of at least 1`);
  return value;
};

const toolOf = (entry: unknown, index: number): ToolSpec => {
  const at = `order.tools[${String(index)}]`;
  const item = objectAt(entry, at);
  const kind = stringAt(item, 'kind', at);
  if (kind !== 'server' && kind !== 'skill') throw new ParseError(`${at}.kind must be "server" or "skill" (packages are out of v1)`);
  return { name: stringAt(item, 'name', at), kind, pin: optionalStringAt(item, 'pin', at) ?? null };
};

export const parseOrder = (text: string, fleet: FleetManifest): Order => {
  const root = objectAt(parseJson(text, 'order'), 'order');
  const line = lineOf(root);
  const taskSetVersion = stringAt(root, 'taskSetVersion', 'order');
  const manifestVersion = stringAt(root, 'manifestVersion', 'order');
  const harness = stringAt(root, 'harness', 'order');
  const modelId = stringAt(root, 'modelId', 'order');

  if (manifestVersion !== fleet.version) throw new ParseError(`order names manifest "${manifestVersion}" but the fleet manifest is "${fleet.version}"`);
  const entry = fleet.harnesses.find((candidate) => candidate.name === harness);
  if (entry === undefined) throw new ParseError(`order harness "${harness}" is not in manifest ${fleet.version}`);
  if (!entry.modelIds.includes(modelId)) throw new ParseError(`order model "${modelId}" is not one of ${harness}'s model IDs in manifest ${fleet.version}`);

  const tools = arrayAt(root, 'tools', 'order').map(toolOf);
  const arms = arrayAt(root, 'arms', 'order').map((arm) => {
    if (typeof arm !== 'string' || arm === '') throw new ParseError('order.arms must hold non-empty strings');
    return arm;
  });
  if (arms.length === 0) throw new ParseError('order.arms must not be empty');
  for (const arm of arms) {
    if (arm !== NO_TOOL && !tools.some((tool) => tool.name === arm)) throw new ParseError(`order arm "${arm}" names no tool`);
  }

  const sideVersions: string[] = [];
  const sides = arrayAt(root, 'sides', 'order').map((value, index) => {
    const at = `order.sides[${String(index)}]`;
    const item = objectAt(value, at);
    sideVersions.push(optionalStringAt(item, 'taskSetVersion', at) ?? taskSetVersion);
    return { name: stringAt(item, 'name', at), pin: stringAt(item, 'pin', at) };
  });
  if (sideVersions.some((version) => version !== taskSetVersion)) throw new ParseError(`order mixes task-set versions: every run uses ${taskSetVersion}`);

  if (line === 'retest') {
    if (sides.length !== 2) throw new ParseError('a retest needs exactly two sides, each with a pin');
    if (sides[0]?.name === sides[1]?.name) throw new ParseError('a retest needs two distinct side names');
    if (tools.length !== 1) throw new ParseError('a retest orders one tool');
    if (arms.length !== 1 || arms[0] !== tools[0]?.name) throw new ParseError('a retest\'s arms are the one tool (the sides are its pins)');
  } else {
    if (sides.length !== 0) throw new ParseError('a comparison has no sides');
    for (const tool of tools) {
      if (tool.pin === null) throw new ParseError(`comparison tool "${tool.name}" needs a pin`);
    }
  }

  return { orderId: stringAt(root, 'orderId', 'order'), line, taskSetVersion, manifestVersion, harness, modelId, account: stringAt(root, 'account', 'order'), tools, arms, sides, repeats: positiveInt(root, 'repeats', DEFAULT_REPEATS), runCap: positiveInt(root, 'runCap', undefined) };
};
