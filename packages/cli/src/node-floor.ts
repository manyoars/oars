/**
 * The oldest Node the CLI supports (`engines.node` in package.json): the latest 22.x when the floor leg of `.github/workflows/ci.yml`
 * (`cli-node-floor`) passed the whole CLI suite on it (run 42783202609, `cli on Node 22.23.4`). The one proven cause below it is `node:sqlite`
 * URI filenames (`sessions/opencode.ts:91`), which Node 22.13 rejected (t1087 run 42776737858).
 */
export const MIN_NODE = '22.23.4';

const parts = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10));

const atLeast = (version: string, floor: string): boolean => {
  const have = parts(version);
  const need = parts(floor);
  const at = need.findIndex((value, index) => (have[index] ?? 0) !== value);
  return at === -1 || (have[at] ?? 0) > (need[at] ?? 0);
};

/** One line for a Node older than the floor, or undefined when `version` (as in `process.versions.node`) is new enough. */
export const nodeFloorMessage = (version: string): string | undefined =>
  atLeast(version, MIN_NODE) ? undefined : `oars needs Node ${MIN_NODE} or newer; this is Node ${version}.`;

/** Writes the one line plus a newline and exits 1 on a Node under the floor; does neither otherwise. `write` and `exit` are injected so a test can see both. */
export const exitIfTooOld = (version: string, write: (text: string) => unknown, exit: (code: number) => unknown): void => {
  const tooOld = nodeFloorMessage(version);
  if (tooOld !== undefined) {
    write(`${tooOld}\n`);
    exit(1);
  }
};
