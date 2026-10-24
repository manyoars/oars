// What `npm publish -w packages/cli` would upload, read from `npm pack --dry-run --json`: the built CLI with the bin that
// `oars` runs, the golden deploy plans aor-web's parity check reads, and LICENSE; never the TypeScript source, a test or the
// fake platform. `--ignore-scripts` keeps this test from rebuilding dist/ while the other tests run beside it; the root check
// script builds first (the build also copies the plans in), and `prepack` rebuilds at publish.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cliFolder = fileURLToPath(new URL('../', import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// One command string through the shell: npm is npm.cmd on Windows, and an args array with `shell` is deprecated (DEP0190).
const packedPaths = (): string[] => {
  const npm = spawnSync('npm pack --dry-run --json --ignore-scripts -w packages/cli', { cwd: root, encoding: 'utf8', shell: true });
  expect(npm.status, npm.stderr).toBe(0);
  const parsed: unknown = JSON.parse(npm.stdout);
  // npm 12 keys the result by workspace name; older npm lists the packages in an array.
  const entries: unknown[] = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.values(parsed) : [];
  const entry = entries[0];
  const files = isRecord(entry) ? entry.files : undefined;
  if (!Array.isArray(files)) throw new Error(`npm pack --json listed no files: ${npm.stdout}`);
  return files.map((file: unknown) => (isRecord(file) && typeof file.path === 'string' ? file.path : '?'));
};

const manifest = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!isRecord(parsed)) throw new Error('package.json is not an object');
  return parsed;
};

// The repo's golden plans: the package must ship exactly these, whatever templates the catalog grows.
const goldenPlans = (): string[] => readdirSync(`${root}parity/deploy-plans`).filter((name) => name.endsWith('.json')).sort();

describe('the tarball npm pack would make', () => {
  let paths: string[] = [];
  beforeAll(() => {
    paths = packedPaths();
  }, 120_000);

  it('lists the bin oars runs, the built CLI, package.json, README.md and LICENSE', () => {
    expect(paths, 'run `npm run build -w packages/cli` first').toEqual(
      expect.arrayContaining(['dist/bin.js', 'dist/cli.js', 'dist/cli.d.ts', 'package.json', 'README.md', 'LICENSE']),
    );
  });

  it('lists the bin file the manifest names', () => {
    const bin = manifest().bin;
    const target = isRecord(bin) && typeof bin.oars === 'string' ? bin.oars.replace(/^\.\//, '') : undefined;

    expect(target).toBe('dist/bin.js');
    expect(paths).toContain(target);
  });

  it('lists every golden deploy plan under parity/deploy-plans/, and no other plan', () => {
    const golden = goldenPlans();

    expect(golden.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('parity/deploy-plans/')).sort()).toEqual(golden.map((name) => `parity/deploy-plans/${name}`));
  });

  it('ships plans that equal the repo golden plans byte for byte', () => {
    for (const name of goldenPlans()) {
      expect(readFileSync(`${cliFolder}parity/deploy-plans/${name}`, 'utf8'), name).toBe(readFileSync(`${root}parity/deploy-plans/${name}`, 'utf8'));
    }
  });

  it('lists no TypeScript source, no test file, no fake platform and no live test', () => {
    const unwanted = paths.filter(
      (path) =>
        path.startsWith('src/') ||
        path.startsWith('scripts/') ||
        /\.test\.[cm]?[jt]s$/.test(path) ||
        /(^|\/)(fake-platform|test-support)\.[cm]?[jt]s$/.test(path) ||
        /\.live\.[cm]?[jt]s$/.test(path) ||
        (/\.[cm]?ts$/.test(path) && !path.endsWith('.d.ts')),
    );

    expect(unwanted).toEqual([]);
  });

  it('lists nothing but dist/, the golden plans and the three files npm always adds', () => {
    expect(
      paths.filter((path) => !path.startsWith('dist/') && !path.startsWith('parity/deploy-plans/') && !['package.json', 'README.md', 'LICENSE'].includes(path)),
    ).toEqual([]);
  });
});

describe('the publish fields', () => {
  it('name the public scoped package at 0.1.1, Apache-2.0, built from this folder of the public repository', () => {
    expect(manifest()).toMatchObject({
      name: '@manyoars/oars',
      version: '0.1.1',
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'git+https://github.com/manyoars/oars.git', directory: 'packages/cli' },
      publishConfig: { access: 'public' },
      engines: { node: '>=24' },
    });
    expect(manifest()).not.toHaveProperty('private');
  });

  it('ship dist/ and the plans, run oars from dist/bin.js and rebuild before every pack', () => {
    expect(manifest()).toMatchObject({
      bin: { oars: './dist/bin.js' },
      files: ['dist', 'parity/deploy-plans'],
      scripts: { prepack: 'npm run build' },
    });
  });
});
