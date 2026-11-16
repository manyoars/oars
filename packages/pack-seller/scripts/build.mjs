// Builds dist/ with tsc from src/ (tsconfig.build.json). dist/ is emptied first so a deleted source file cannot linger in the image.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @param {string} path relative to packages/pack-seller */
const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(here('dist'), { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '--project', here('tsconfig.build.json')], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
