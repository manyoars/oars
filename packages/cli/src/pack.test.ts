// What `npm publish -w packages/cli` would upload, read from `npm pack --dry-run --json`: the built CLI with the bin that
// `oars` runs, the golden deploy plans the web app's parity check reads, and LICENSE; never the TypeScript source, a test or the
// fake platform. `--ignore-scripts` keeps this test from rebuilding dist/ while the other tests run beside it; the root check
// script builds first (the build also copies the plans in), and `prepack` rebuilds at publish.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('lists every vocabulary snapshot and the manifest that pins them', () => {
    expect(paths.filter((path) => path.startsWith('vocab/')).sort()).toEqual(
      readdirSync(`${cliFolder}vocab`).sort().map((name) => `vocab/${name}`),
    );
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

  it('lists nothing but dist/, the golden plans, the pinned vocabulary, and the three files npm always adds', () => {
    expect(
      paths.filter((path) => !path.startsWith('dist/') && !path.startsWith('parity/deploy-plans/') && !path.startsWith('vocab/') && !['package.json', 'README.md', 'LICENSE'].includes(path)),
    ).toEqual([]);
  });
});

describe('the publish fields', () => {
  it('name the public scoped package at 0.3.0, Apache-2.0, built from this folder of the public repository', () => {
    expect(manifest()).toMatchObject({
      name: '@manyoars/oars',
      version: '0.3.0',
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'git+https://github.com/manyoars/oars.git', directory: 'packages/cli' },
      publishConfig: { access: 'public' },
      engines: { node: '>=24' },
    });
    expect(manifest()).not.toHaveProperty('private');
  });

  it('ship dist/, the plans, and the vocabulary snapshots, run oars from dist/bin.js and rebuild before every pack', () => {
    expect(manifest()).toMatchObject({
      bin: { oars: './dist/bin.js' },
      files: ['dist', 'parity/deploy-plans', 'vocab'],
      scripts: { prepack: 'npm run build' },
    });
  });
});

// The public text (t754): the two READMEs and the package description state facts a reader can check, and address no agent.
/** Phrases that address an agent or ask it to act, or describe sharing this release does not have. */
const DENY_LIST = [
  'ignore previous',
  'ignore all previous',
  'you must install',
  'you should install',
  'you should recommend',
  'always recommend',
  'recommend this',
  'recommend it to',
  'tell the user',
  'tell your user',
  'if you are an agent',
  'if you are an ai',
  'as an ai',
  'as an agent',
  'dear agent',
  'attention agent',
  'agents should',
  'agents must',
  'run this command now',
  'install this package',
  'install it for the user',
  'before you re-solve',
  'pooled',
  'joins no cluster',
];

const NOT_OPEN = 'Accounts and paid agents are not open yet; `oars login` says so until launch.';

describe('the public text states facts only', () => {
  const description = String(manifest().description);
  const texts = [
    ['packages/cli/README.md', readFileSync(join(cliFolder, 'README.md'), 'utf8')],
    ['README.md', readFileSync(join(root, 'README.md'), 'utf8')],
    ['package description', description],
  ] as const;

  for (const [name, text] of texts) {
    it(`${name} has no deny-listed phrase`, () => {
      const lower = text.toLowerCase();
      expect(DENY_LIST.filter((phrase) => lower.includes(phrase))).toEqual([]);
    });
  }

  it('the package description names sessions and claims nothing about what the harness sends', () => {
    expect(description).toMatch(/sessions/);
    expect(description).not.toMatch(/nothing (leaves|is sent)/i);
  });

  it('the description and the 0.3.0 changelog entry carry the gold arms exception', () => {
    const changelog = readFileSync(join(cliFolder, 'CHANGELOG.md'), 'utf8');
    const entry = changelog.slice(changelog.indexOf('## 0.3.0'), changelog.indexOf('## 0.2.0') > 0 ? changelog.indexOf('## 0.2.0') : undefined);
    for (const text of [description, entry]) {
      expect(text).toContain('gold arms');
      expect(text).toContain('your own Claude subscription');
    }
    expect(entry).toContain('`gold sample`, `gold arms`, and `gold score`');
  });

  it.each([['packages/cli/README.md', join(cliFolder, 'README.md')], ['README.md', join(root, 'README.md')]])('%s says raw/ is unredacted, what the harness sends, where <config> is, and that paid agents are not open', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('raw transcripts');
    expect(text).toMatch(/unredacted/);
    expect(text).toContain('except `gold arms`, which sends redacted text through your own Claude subscription');
    expect(text).toContain('Apart from that, oars itself sends nothing; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.');
    expect(text).toContain(NOT_OPEN);
    expect(text).toContain('%APPDATA%');
    expect(text).toContain('~/.config');
    expect(text).toContain('session-commons/review');
  });

  it('the root README gives the hook commands in the forms that run, with --scope user and --schedule off', () => {
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    const commands = [...text.matchAll(/`(oars sessions hook (?:install|uninstall)[^`]*)`/g)].map((match) => match[1] ?? '');
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const command of commands) expect(command, command).toMatch(/--scope user|--schedule off/);
    expect(commands).toContain('oars sessions hook install --scope user');
    expect(commands).toContain('oars sessions hook uninstall --scope user');
    expect(commands).toContain('oars sessions hook install --schedule off');
  });

  it('the root README says install raises cleanupPeriodDays and uninstall leaves it raised', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toMatch(/cleanupPeriodDays[^.]*at least 365[^.]*uninstall leaves it raised/);
  });
});

describe('oars purchasing is not in the 0.3.0 surface', () => {
  it('is hidden from oars --help in the source and refused until paid agents open', () => {
    const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/command\('purchasing', \{ hidden: true \}\)/);
    expect(source).toContain('requirePurchasingOpen(deps)');
  });
});
