// `npx <name>` where the folder already has `node_modules/.bin/<name>` runs the project's own copy and fetches nothing. It is the common case (most main-session `npx` crossings
// whose folder exists), so it gets its own closed form, `local-bin-run`, and is not counted as a fetch-and-run pick. Live and replay both apply this one rule.
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Crossing } from './checks.js';

const LEVELS = 12;
/** A Windows install leaves `.cmd` and `.ps1` shims beside the bare name. */
const SHIMS = ['', '.cmd', '.ps1'];

/** Answers already found, so one folder and bin cost one walk however many calls ask. */
export type LocalBinMemo = Map<string, Promise<boolean>>;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The bin an `npx` name runs: the last segment of a scoped name. */
const binOf = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

const walk = async (cwd: string, bin: string): Promise<boolean> => {
  let folder = cwd;
  for (let level = 0; level < LEVELS; level += 1) {
    for (const shim of SHIMS) {
      if (await exists(join(folder, 'node_modules', '.bin', `${bin}${shim}`))) return true;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return false;
};

/**
 * The crossing as it should be recorded: `local-bin-run` for an unstated `npx` whose folder, or a parent's, holds the bin, else the crossing itself. A version, a call that chose
 * its own folder or registry (`registryAsked` false), or an unknown folder leaves the question open, so the crossing stays a fetch-and-run.
 */
export const withLocalBin = async (crossing: Crossing, cwd: string | null, memo: LocalBinMemo): Promise<Crossing> => {
  if (crossing.program !== 'npx' || crossing.form !== 'fetch-and-run' || crossing.versionForm !== 'unstated' || !crossing.registryAsked || cwd === null) return crossing;
  const key = `${cwd}\0${binOf(crossing.name)}`;
  const known = memo.get(key) ?? walk(cwd, binOf(crossing.name));
  memo.set(key, known);
  return (await known) ? { ...crossing, form: 'local-bin-run' } : crossing;
};
