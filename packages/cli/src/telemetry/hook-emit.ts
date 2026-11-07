// The emitter a hook process builds for itself. A hook never loads the CLI (`main.ts` reads the version and the folders), so this reads the same two things for itself:
// the config folder the CLI uses, and the version in this package's `package.json`, read only when an event is about to be written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir } from '../credentials.js';
import { emitFor, type Emit } from './emit.js';

/** The version in the package.json at `manifest`; `0.0.0` when it cannot be read (the schema writes a version it cannot read as `unknown`). */
export const versionAt = (manifest: URL): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const version: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

export const hookEmitter = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, manifest: URL, now: () => number): Emit =>
  emitFor({ env, telemetry: { dir: join(defaultConfigDir(env, platform, home), 'oars', 'telemetry'), platform }, version: () => versionAt(manifest), now });
