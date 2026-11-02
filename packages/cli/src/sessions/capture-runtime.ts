// What a capture records about the machine it ran on (`env` on the session record, class P): the oars package version, Node.js, and OS.
// Names and versions only; a library version is recorded only when a transcript states it (t711 ruling L6), and none is read here.
import { readFileSync } from 'node:fs';

/** The `version` in a package.json text, or `0.0.0` when it has none. */
export const versionIn = (manifestText: string): string => {
  const manifest: unknown = JSON.parse(manifestText);
  const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
  return typeof version === 'string' ? version : '0.0.0';
};

/** This package's version: `package.json` sits two folders above both `src/sessions/` and `dist/sessions/`. */
export const oarsVersion = (): string => versionIn(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export interface CaptureRuntime {
  oars: string;
  node: string;
  os: string;
}

export const captureRuntime = (): CaptureRuntime => ({ oars: oarsVersion(), node: process.version, os: process.platform });
