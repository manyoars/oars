/** The oldest Node major the CLI supports (`engines.node` in package.json). `node:sqlite` URI filenames and the built hooks need it; CI on 22.13 failed 66 tests. */
export const MIN_NODE_MAJOR = 24;

/** One line for a Node older than the floor, or undefined when `version` (as in `process.versions.node`) is new enough. */
export const nodeFloorMessage = (version: string): string | undefined =>
  Number.parseInt(version, 10) >= MIN_NODE_MAJOR ? undefined : `oars needs Node ${String(MIN_NODE_MAJOR)} or newer; this is Node ${version}.`;
