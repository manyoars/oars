// Builds dist/, the only folder the published package ships: tsc emits the JavaScript and declarations from src/
// (tsconfig.build.json), then the generated wire types are copied in, because tsc never copies a .d.ts and dist/index.d.ts
// re-exports them. dist/ is emptied first so a deleted source file cannot linger in the tarball.
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @param {string} path relative to packages/client */
const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(here('dist'), { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '--project', here('tsconfig.build.json')], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
cpSync(here('src/generated/schema.d.ts'), here('dist/generated/schema.d.ts'));
