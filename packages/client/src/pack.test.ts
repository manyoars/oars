// What `npm publish -w packages/client` would upload, read from `npm pack --dry-run --json`: the built JavaScript and its
// declarations, never the TypeScript source or its tests. `--ignore-scripts` keeps this test from rebuilding dist/ while the
// template tests (which import it) run beside it; the root check script builds first, and `prepack` rebuilds at publish.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// One command string through the shell: npm is npm.cmd on Windows, and an args array with `shell` is deprecated (DEP0190).
const packedPaths = (): string[] => {
  const npm = spawnSync('npm pack --dry-run --json --ignore-scripts -w packages/client', { cwd: root, encoding: 'utf8', shell: true });
  expect(npm.status, npm.stderr).toBe(0);
  const parsed: unknown = JSON.parse(npm.stdout);
  // npm 12 keys the result by workspace name; older npm lists the packages in an array.
  const [entry] = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.values(parsed) : [];
  const files = isRecord(entry) ? entry.files : undefined;
  if (!Array.isArray(files)) throw new Error(`npm pack --json listed no files: ${npm.stdout}`);
  return files.map((file: unknown) => (isRecord(file) && typeof file.path === 'string' ? file.path : '?'));
};

const manifest = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!isRecord(parsed)) throw new Error('package.json is not an object');
  return parsed;
};

describe('the tarball npm pack would make', () => {
  let paths: string[] = [];
  beforeAll(() => {
    paths = packedPaths();
  }, 120_000);

  it('lists the built entry point, its declarations, package.json, README.md and LICENSE', () => {
    expect(paths, 'run `npm run build -w packages/client` first').toEqual(
      expect.arrayContaining(['dist/index.js', 'dist/index.d.ts', 'dist/generated/schema.d.ts', 'package.json', 'README.md', 'LICENSE']),
    );
  });

  it('lists no TypeScript source and no test file', () => {
    const source = paths.filter((path) => path.startsWith('src/') || /\.test\.[cm]?[jt]s$/.test(path) || (/\.[cm]?ts$/.test(path) && !path.endsWith('.d.ts')));

    expect(source).toEqual([]);
  });

  it('lists nothing but dist/ and the three files npm always adds', () => {
    expect(paths.filter((path) => !path.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(path))).toEqual([]);
  });
});

describe('the publish fields', () => {
  it('name the public scoped package at 0.1.0, Apache-2.0, built from this folder of the public repository', () => {
    expect(manifest()).toMatchObject({
      name: '@manyoars/oars-client',
      version: '0.1.0',
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'git+https://github.com/manyoars/oars.git', directory: 'packages/client' },
      publishConfig: { access: 'public' },
      engines: { node: '>=24' },
    });
    expect(manifest()).not.toHaveProperty('private');
  });

  it('point exports and types at dist/, never at src/', () => {
    expect(manifest()).toMatchObject({
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
    });
  });
});
