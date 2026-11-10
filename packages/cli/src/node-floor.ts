/** The oldest Node major the CLI supports (`engines.node` in package.json). Proven cause: `node:sqlite` URI filenames (`sessions/opencode.ts:91`) fail on Node 22. */
export const MIN_NODE_MAJOR = 24;

/** One line for a Node older than the floor, or undefined when `version` (as in `process.versions.node`) is new enough. */
export const nodeFloorMessage = (version: string): string | undefined =>
  Number.parseInt(version, 10) >= MIN_NODE_MAJOR ? undefined : `oars needs Node ${String(MIN_NODE_MAJOR)} or newer; this is Node ${version}.`;

/** Writes the one line plus a newline and exits 1 on a Node under the floor; does neither otherwise. `write` and `exit` are injected so a test can see both. */
export const exitIfTooOld = (version: string, write: (text: string) => unknown, exit: (code: number) => unknown): void => {
  const tooOld = nodeFloorMessage(version);
  if (tooOld !== undefined) {
    write(`${tooOld}\n`);
    exit(1);
  }
};
