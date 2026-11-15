// Counts from an open skeleton pack's own files: failed calls per error code, failed calls by what followed, and sessions per harness version.
// Usage: node recipes/open-pack-counts/open-pack-counts.mjs <pack folder> [--json] [--by model|class]
// Reads only manifest.jsonl, pack.json (optional), and sessions/<match id>/skeleton.json. Offline: no network, no store, no dependency.
// Exit 0 on success, 1 when a file the schema requires is missing (the path is on stderr), 2 on bad usage.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node recipes/open-pack-counts/open-pack-counts.mjs <pack folder> [--json] [--by model|class]';
const BY = ['model', 'class'];

/** Thrown for a file the schema requires and the pack lacks. */
class MissingFile extends Error {}

/**
 * @param {string} path
 * @returns {string}
 */
const readRequired = (path) => {
  if (!existsSync(path)) throw new MissingFile(`missing required file: ${path}`);
  return readFileSync(path, 'utf8');
};

/**
 * @param {Map<string, number>} tally
 * @param {string} key
 */
const add = (tally, key) => {
  tally.set(key, (tally.get(key) ?? 0) + 1);
};

/**
 * @param {Map<string, number>} tally
 * @returns {Record<string, number>}
 */
const sorted = (tally) => Object.fromEntries([...tally].sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {string} text
 * @returns {unknown}
 */
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * @typedef {{
 *   pack: { name: string; built: string | null; keyId: string | null };
 *   manifestRows: number;
 *   sessionsRead: number;
 *   skipped: Array<{ file: string; line?: number; reason: string }>;
 *   failedCallsPerErrorCode: Record<string, number>;
 *   failedCallsByWhatFollowed: Record<string, number>;
 *   sessionsPerHarnessVersion: Record<string, number>;
 *   failedCallsPerModel?: Record<string, number>;
 *   failedCallsPerPromptClass?: Record<string, number>;
 * }} PackCounts
 */

/**
 * @param {string} folder the pack folder
 * @param {string | undefined} by split the failed calls by `model` or `class` too
 * @returns {PackCounts}
 */
export const countPack = (folder, by) => {
  const manifest = readRequired(join(folder, 'manifest.jsonl'));
  const packJson = existsSync(join(folder, 'pack.json')) ? parse(readFileSync(join(folder, 'pack.json'), 'utf8')) : undefined;
  const pack = isObject(packJson) ? packJson : {};
  /** @type {Array<{ file: string; line?: number; reason: string }>} */
  const skipped = [];
  /** @type {Map<string, number>} */
  const versions = new Map();
  /** @type {Map<string, number>} */
  const codes = new Map();
  /** @type {Map<string, number>} */
  const followed = new Map([
    ['edit followed', 0],
    ['no edit followed', 0],
    ['not recorded', 0],
  ]);
  /** @type {Map<string, number>} */
  const split = new Map();
  /** @type {string[]} */
  const ids = [];
  let manifestRows = 0;
  manifest.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const row = parse(line);
    if (!isObject(row) || typeof row.matchId !== 'string' || !Array.isArray(row.harnessVersions)) {
      skipped.push({ file: 'manifest.jsonl', line: index + 1, reason: row === undefined ? 'not valid JSON' : 'not a manifest row' });
      return;
    }
    manifestRows += 1;
    ids.push(row.matchId);
    for (const version of new Set(row.harnessVersions)) {
      if (typeof version === 'string') add(versions, version);
      else skipped.push({ file: 'manifest.jsonl', line: index + 1, reason: 'harness version is not text' });
    }
  });
  let sessionsRead = 0;
  for (const id of ids) {
    const skeleton = parse(readRequired(join(folder, 'sessions', id, 'skeleton.json')));
    if (!isObject(skeleton) || !Array.isArray(skeleton.transcripts)) {
      skipped.push({ file: `sessions/${id}/skeleton.json`, reason: skeleton === undefined ? 'not valid JSON' : 'no transcripts list' });
      continue;
    }
    sessionsRead += 1;
    const file = `sessions/${id}/skeleton.json`;
    for (const [t, transcript] of skeleton.transcripts.entries()) {
      if (!isObject(transcript) || !Array.isArray(transcript.tools)) {
        skipped.push({ file, reason: `transcript ${t} has no tools list` });
        continue;
      }
      const prompts = Array.isArray(transcript.prompts) ? transcript.prompts : [];
      for (const [n, tool] of transcript.tools.entries()) {
        if (!isObject(tool)) {
          skipped.push({ file, reason: `tool ${n} of transcript ${t} is not an object` });
          continue;
        }
        if (typeof tool.errorCode !== 'string') continue;
        add(codes, tool.errorCode);
        const recovery = tool.recoveryCalls;
        if (!isObject(recovery) || typeof recovery.editFollowed !== 'boolean') add(followed, 'not recorded');
        else add(followed, recovery.editFollowed ? 'edit followed' : 'no edit followed');
        if (by !== undefined) {
          const prompt = typeof tool.prompt === 'number' ? prompts[tool.prompt] : undefined;
          const frame = isObject(prompt) && isObject(prompt.frame) ? prompt.frame : {};
          const value = by === 'model' ? frame.model : isObject(prompt) ? prompt.cls : undefined;
          add(split, typeof value === 'string' ? value : 'unknown');
        }
      }
    }
  }
  return {
    pack: { name: basename(resolve(folder)), built: typeof pack.built === 'string' ? pack.built : null, keyId: typeof pack.keyId === 'string' ? pack.keyId : null },
    manifestRows,
    sessionsRead,
    skipped,
    failedCallsPerErrorCode: sorted(codes),
    failedCallsByWhatFollowed: Object.fromEntries(followed),
    sessionsPerHarnessVersion: sorted(versions),
    ...(by === undefined ? {} : { [by === 'model' ? 'failedCallsPerModel' : 'failedCallsPerPromptClass']: sorted(split) }),
  };
};

/**
 * @param {string} title
 * @param {Record<string, number>} counts
 * @param {boolean} total whether to add a total row
 * @returns {string[]}
 */
const table = (title, counts, total) => {
  const rows = Object.entries(counts).map(([name, n]) => [name, String(n)]);
  if (total) rows.push(['total', String(Object.values(counts).reduce((sum, n) => sum + n, 0))]);
  const width = Math.max(0, ...rows.map(([name]) => (name ?? '').length));
  return [title, ...rows.map(([name, n]) => `  ${(name ?? '').padEnd(width)}  ${n}`), ''];
};

/** @param {PackCounts} result */
const text = (result) => {
  const { pack } = result;
  const lines = [
    `Pack: ${pack.name} (built ${pack.built ?? 'unknown'}, key ${pack.keyId ?? 'unknown'})`,
    `Sessions read: ${result.sessionsRead} of ${result.manifestRows} manifest rows. Skipped: ${result.skipped.length}.`,
    ...result.skipped.map((s) => `  skipped: ${s.file}${s.line === undefined ? '' : ` line ${s.line}`}: ${s.reason}`),
    '',
    ...table('Failed calls per error code', result.failedCallsPerErrorCode, true),
    ...table('Failed calls by what followed', result.failedCallsByWhatFollowed, false),
    ...table('Sessions per harness version', result.sessionsPerHarnessVersion, false),
  ];
  if (result.failedCallsPerModel) lines.push(...table('Failed calls per model', result.failedCallsPerModel, true));
  if (result.failedCallsPerPromptClass) lines.push(...table('Failed calls per prompt class', result.failedCallsPerPromptClass, true));
  return lines.join('\n');
};

const run = () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const byAt = args.indexOf('--by');
  const by = byAt === -1 ? undefined : args[byAt + 1];
  const rest = args.filter((arg, i) => arg !== '--json' && i !== byAt && !(byAt !== -1 && i === byAt + 1));
  const folder = rest[0];
  if (folder === undefined || rest.length !== 1 || (byAt !== -1 && (by === undefined || !BY.includes(by)))) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = countPack(folder, by);
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${text(result)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof MissingFile)) throw error;
    console.error(`open-pack-counts: ${error.message}`);
    return 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = run();
