// What `npm publish -w packages/cli` would upload, read from `npm pack --dry-run --json`: the built CLI with the bin that
// `oars` runs, the pinned vocabulary, and LICENSE; never the TypeScript source or a test. `--ignore-scripts` keeps this test from rebuilding dist/ while the other tests run beside it; the root check
// script builds first, and `prepack` rebuilds at publish.
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

  it('lists every vocabulary snapshot and the manifest that pins them', () => {
    expect(paths.filter((path) => path.startsWith('vocab/')).sort()).toEqual(
      readdirSync(`${cliFolder}vocab`).sort().map((name) => `vocab/${name}`),
    );
  });

  it('lists no TypeScript source, no test file, no test support, no compiled fixture and no live test', () => {
    const unwanted = paths.filter(
      (path) =>
        path.startsWith('src/') ||
        path.startsWith('scripts/') ||
        /\.test\.[cm]?[jt]s$/.test(path) ||
        /(^|\/)test-support\.[cm]?[jt]s$/.test(path) ||
        /\.live\.[cm]?[jt]s$/.test(path) ||
        /(^|\/)[\w-]*fixtures?\.(d\.ts|[cm]?js)$/.test(path) ||
        (/\.[cm]?ts$/.test(path) && !path.endsWith('.d.ts')),
    );

    expect(unwanted).toEqual([]);
  });

  it('lists nothing but dist/, the pinned vocabulary, and the three files npm always adds', () => {
    expect(
      paths.filter((path) => !path.startsWith('dist/') && !path.startsWith('vocab/') && !['package.json', 'README.md', 'LICENSE'].includes(path)),
    ).toEqual([]);
  });
});

// dist/sessions/public-vocabulary.js and its .d.ts are the pinned list of public tool and site names a session projects (`stripe` the CLI,
// docs.stripe.com): ecosystem names, not terms of this product.
const ECOSYSTEM_LISTS = ['dist/sessions/public-vocabulary.js', 'dist/sessions/public-vocabulary.d.ts'];

describe('the packed dist names none of the withheld terms', () => {
  it('has no withheld term in any packed dist file, declarations included', () => {
    const hits = packedPaths()
      .filter((path) => path.startsWith('dist/') && !ECOSYSTEM_LISTS.includes(path))
      .flatMap((path) => withheldIn(readFileSync(join(cliFolder, path), 'utf8')).map((term) => `${path}: ${term}`));
    expect(hits).toEqual([]);
  }, 120_000);
});

describe('the publish fields', () => {
  it('name the public scoped package at 0.4.0, Apache-2.0, built from this folder of the public repository', () => {
    expect(manifest()).toMatchObject({
      name: '@manyoars/oars',
      version: '0.4.0',
      license: 'Apache-2.0',
      repository: { type: 'git', url: 'git+https://github.com/manyoars/oars.git', directory: 'packages/cli' },
      publishConfig: { access: 'public' },
      engines: { node: '>=24' },
    });
    expect(manifest()).not.toHaveProperty('private');
  });

  it('ship dist/ and the vocabulary snapshots, run oars from dist/bin.js and rebuild before every pack', () => {
    expect(manifest()).toMatchObject({
      bin: { oars: './dist/bin.js' },
      files: ['dist', 'vocab'],
      scripts: { prepack: 'npm run build' },
    });
  });
});

// The public text: the two READMEs and the package description state facts a reader can check, and address no agent.
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
  'npx skills add',
  'before you re-solve',
  'pooled',
  'joins no cluster',
];

const NOT_OPEN = 'Accounts are not open yet: `oars login` uses the Many Oars issuer by default, and until Many Oars sign-in at `login.manyoars.com` is deployed it exits 2 with an error that names `login.manyoars.com`.';

const WITHHELD_TERMS = [
  /\bprices?\b/i,
  /pricing/i,
  /\bfees?\b/i,
  /get paid/i,
  /billing/i,
  /\bcharg(?:e|es|ed|ing)\b/i,
  /stripe/i,
  /test-charge/i,
  /purchas/i,
  /payout/i,
  /payment/i,
  /revenue/i,
  /1099/,
  /take-home/i,
  /make-me-money/i,
  /paid[- ]agent/i,
  /paid-api/i,
  /per-task-agent/i,
  /buyer/i,
  /\bsell/i,
  /\bearn/i,
  /\bmoney/i,
  /pay per/i,
  /\bcredits?\b/i,
  /\bUSD\b/,
];
const withheldIn = (text: string): string[] => WITHHELD_TERMS.filter((term) => term.test(text)).map(String);

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

  it.each([
    ['packages/cli/README.md', join(cliFolder, 'README.md')],
    ['README.md', join(root, 'README.md')],
    ['packages/cli/CHANGELOG.md', join(cliFolder, 'CHANGELOG.md')],
    ['packages/client/README.md', join(root, 'packages/client/README.md')],
    ['packages/client/CHANGELOG.md', join(root, 'packages/client/CHANGELOG.md')],
    // The generated surface: the public spec, the operations it lists, and the types made from it. A code or field name such as
    // COMPUTE_CREDIT_EXHAUSTED or autoRestartOnCredit is a wire name the platform owns and has no word boundary, so it does not match.
    ['openapi/public.json', join(root, 'openapi/public.json')],
    ['openapi/public-operations.json', join(root, 'openapi/public-operations.json')],
    ['packages/client/src/generated/schema.d.ts', join(root, 'packages/client/src/generated/schema.d.ts')],
  ])('%s names none of the withheld terms', (_name, file) => {
    expect(withheldIn(readFileSync(file, 'utf8'))).toEqual([]);
  });

  // The word-boundary terms above cannot see a camelCase wire name (createCharge, ChargeView, listAgentPrices, priceCents) or a
  // reworded error text, so the generated files get a plain substring scan too. The allow-list is every remaining hit, named: a
  // workload restart setting and a compute-limit code the platform owns. A new hit fails until someone looks at it.
  const WIRE_NAMES_KEPT = ['autoRestartOnCredit', 'COMPUTE_CREDIT_EXHAUSTED'];
  /** @returns every word of `text` that holds price, charge, credit, or usd, except the kept names */
  const wireNamesIn = (text: string): string[] =>
    WIRE_NAMES_KEPT.reduce((rest, name) => rest.replaceAll(name, ''), text).match(/\w*(?:price|charge|credit|usd)\w*/gi) ?? [];
  it.each([
    ['openapi/public.json', join(root, 'openapi/public.json')],
    ['openapi/public-operations.json', join(root, 'openapi/public-operations.json')],
    ['packages/client/src/generated/schema.d.ts', join(root, 'packages/client/src/generated/schema.d.ts')],
  ])('%s has no price, charge, credit, or usd name beyond the kept wire names', (_name, file) => {
    expect(wireNamesIn(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('the wire-name scan sees a camelCase USD name and a reworded name, and skips only the kept ones', () => {
    expect(wireNamesIn('"fooCostUsd": { "type": "string" }')).toEqual(['fooCostUsd']);
    expect(wireNamesIn('"listAgentPrices", "ChargeView", "autoRestartOnCredit", "COMPUTE_CREDIT_EXHAUSTED"')).toEqual([
      'listAgentPrices',
      'ChargeView',
    ]);
  });

  it('the package description names none of the withheld terms', () => {
    expect(withheldIn(description)).toEqual([]);
  });

  it('the package description names no command that is not in the CLI', () => {
    expect(description).not.toMatch(/deploy/i);
  });

  it('the package description names sessions and claims nothing about what the harness sends', () => {
    expect(description).toMatch(/sessions/);
    expect(description).not.toMatch(/nothing (leaves|is sent)/i);
  });

  it('the 0.3.0 changelog entry and both READMEs carry the gold arms exception', () => {
    const changelog = readFileSync(join(cliFolder, 'CHANGELOG.md'), 'utf8');
    const entry = changelog.slice(changelog.indexOf('## 0.3.0'), changelog.indexOf('## 0.2.0') > 0 ? changelog.indexOf('## 0.2.0') : undefined);
    for (const text of [readFileSync(join(cliFolder, 'README.md'), 'utf8'), readFileSync(join(root, 'README.md'), 'utf8'), entry]) {
      expect(text).toContain('gold arms');
      expect(text).toContain('your own Claude subscription');
    }
    expect(entry).toContain('`gold sample`, `gold arms`, and `gold score`');
  });

  it('the package metadata is findable: a short description, the site as homepage, and keywords', () => {
    expect(description.length).toBeLessThan(200);
    expect(manifest().homepage).toBe('https://manyoars.com/');
    expect(manifest().keywords).toEqual(expect.any(Array));
    const keywordCount = String(manifest().keywords).split(',').length;
    expect(keywordCount).toBeGreaterThanOrEqual(6);
    expect(keywordCount).toBeLessThanOrEqual(10);
  });

  it.each([['packages/cli/README.md', join(cliFolder, 'README.md')], ['README.md', join(root, 'README.md')]])('%s says raw/ is unredacted, what the harness sends, where <config> is, and that accounts are not open', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('raw transcripts');
    expect(text).toMatch(/unredacted/);
    expect(text).toContain('except `gold arms`, which sends redacted text through your own Claude subscription');
    expect(text).toContain('Apart from that and telemetry (on by default, off with `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1`; it sends to the pool server in `OARS_POOL_URL`, else to the Many Oars pool at `pool.manyoars.com`, which is live), oars itself sends nothing, except what you opted into with a pool server: after you accept its covenant, the detached sender that a session-end hook or any `oars` command starts, at most about once an hour, sends closed-vocabulary session skeletons, and, only after a separate yes to the raw prompt, a locally redacted (best-effort) copy of each full transcript; `oars pool outbox` prints what is queued when you run it, but the sender builds new batches and sends them in the same run without printing them first, and a session leaves your machine no sooner than an hour after it ends, and a folder can be switched to skeleton only or off; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.');
    expect(text).toContain(NOT_OPEN);
    expect(text).toContain('%APPDATA%');
    expect(text).toContain('~/.config');
    expect(text).toContain('session-commons/review');
  });

  it('the root README gives the hook commands in the forms that run, with --scope user', () => {
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    const commands = [...text.matchAll(/`(oars sessions hook (?:install|uninstall)[^`]*)`/g)].map((match) => match[1] ?? '');
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) expect(command, command).toMatch(/--scope user/);
    expect(commands).toContain('oars sessions hook install --scope user');
    expect(commands).toContain('oars sessions hook uninstall --scope user');
  });

  it('the root README says install raises cleanupPeriodDays and uninstall leaves it raised', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toMatch(/cleanupPeriodDays[^.]*at least 365[^.]*uninstall leaves it raised/);
  });
});
