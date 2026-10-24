// Builds dist/, the only folder the published package ships: tsc emits the JavaScript from src/ (tsconfig.build.json). dist/ is
// emptied first so a deleted source file cannot linger in the tarball. The bin file gets its shebang from src/bin.ts.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @param {string} path relative to packages/cli */
const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(here('dist'), { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '--project', here('tsconfig.build.json')], { stdio: 'inherit' });
process.exit(compiled.status ?? 1);
