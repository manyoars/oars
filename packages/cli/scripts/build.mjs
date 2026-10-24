// Builds what the published package ships besides package.json and LICENSE. dist/: tsc emits the JavaScript from src/
// (tsconfig.build.json); the bin file gets its shebang from src/bin.ts. parity/deploy-plans/: a copy of the repo's golden deploy
// plans, which aor-web's parity check reads from the installed package (design §6, Parity). Both folders are emptied first so a
// deleted source file or plan cannot linger in the tarball.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** @param {string} path relative to packages/cli */
const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(here('dist'), { recursive: true, force: true });
rmSync(here('parity'), { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, '--project', here('tsconfig.build.json')], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const plansSource = here('../../parity/deploy-plans');
const plans = readdirSync(plansSource).filter((name) => name.endsWith('.json'));
if (plans.length === 0) throw new Error(`no golden deploy plan in ${plansSource}`);
mkdirSync(here('parity/deploy-plans'), { recursive: true });
for (const name of plans) copyFileSync(`${plansSource}/${name}`, here(`parity/deploy-plans/${name}`));
