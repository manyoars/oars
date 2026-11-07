// The little a nightly send needs of the command line's dependencies: the environment, the session store, the version, and the clock. It prints nothing, signs nobody in, and opens no browser.
import type { RunDeps } from '../cli.js';
import type { SessionsRuntime } from './store.js';

export const nightlyPoolDeps = (env: NodeJS.ProcessEnv, sessions: SessionsRuntime, version: string, now: () => number): RunDeps => ({
  env,
  io: { stdout: () => undefined, stderr: () => undefined },
  store: { read: () => Promise.resolve(undefined), write: () => Promise.resolve(), delete: () => Promise.resolve() },
  version,
  sleep: () => Promise.resolve(),
  random: () => 0,
  now,
  openBrowser: () => Promise.resolve(),
  sessions,
});
