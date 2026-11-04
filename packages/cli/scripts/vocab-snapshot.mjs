// Regenerates the pinned vocabulary snapshots in packages/cli/vocab/ from their public sources (pool vocabulary spec Section 1.3, the name seed).
//
//   node packages/cli/scripts/vocab-snapshot.mjs [--only npm,pypi,...] [--date YYYY-MM-DD]
//
// Standard library only, plus the `tar` on PATH (Git for Windows and every Unix ship one). It asks public, unauthenticated endpoints with a generic
// User-Agent and sends nothing about the operator. A run replaces the files it writes and then rewrites vocab/manifest.json with each file's byte
// size and SHA-256. A changed snapshot is a new VOCAB_VERSION: bump VOCAB_VERSION in src/sessions/public-vocabulary.ts and the pin table in
// src/sessions/vocab-pin.test.ts in the same commit, or that test fails.
//
// Sources, one per file (the shipped sizes are in the CHANGELOG and the report):
//   npm.json       packages.ecosyste.ms (npm's own monthly download count, ranked), versions from registry.npmjs.org
//   pypi.json      hugovk.github.io/top-pypi-packages (PyPI's own download log, 30 days), versions from pypi.org
//   crates.json    crates.io /api/v1/crates?sort=downloads, versions from the sparse index at index.crates.io
//   rubygems.json  packages.ecosyste.ms (rubygems.org's own download count, ranked), versions from rubygems.org
//   homebrew.json  formulae.brew.sh analytics (30 days of installs) and formula.json (the one current version)
//   go.json, maven.json  nothing seeded: neither the Go proxy nor Maven Central publishes download counts, so every name there is private
//   programs.json  tldr-pages at a pinned commit: a program per page, a subcommand per `program-sub` page, flags from the page's examples
//   models.json    models.dev: every provider's model ids
//   harness.json   registry.npmjs.org: every published version of each harness's CLI package

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_TOP = 1000;
/** Names ranked just past `seed_top`: they resolve in the snapshot but are not seeded, which is what the outside-`seed_top` proof needs. */
const RESOLVED_TAIL = 200;
const AGENT = 'oars-vocab-snapshot (+https://github.com/manyoars/oars)';
const OUT = fileURLToPath(new URL('../vocab/', import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};
const only = flag('--only')?.split(',') ?? null;
const date = flag('--date') ?? new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} url @param {{ accept?: string, text?: boolean }} [options] */
const get = async (url, options = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': AGENT, accept: options.accept ?? 'application/json' }, redirect: 'follow' });
      if (response.status === 404) return null;
      if (response.status === 429 || response.status >= 500) throw new Error(`${response.status} ${url}`);
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return options.text === true ? await response.text() : await response.json();
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(1500 * 2 ** attempt);
    }
  }
};

/** Runs `work` over every item, `width` at a time, keeping the order of the results. */
const each = async (items, width, work) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let at = next++; at < items.length; at = next++) results[at] = await work(items[at], at);
    }),
  );
  return results;
};

const normalizeNpm = (name) => name.toLowerCase();
const normalizePypi = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const normalizeCrate = (name) => name.toLowerCase().replace(/_/g, '-');
const normalizeGem = (name) => name;

const write = (file, value) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, file), `${JSON.stringify(value)}\n`);
  console.log(`wrote ${file}`);
};

/** A package ecosystem file: the seeded names with their versions, then the resolved tail by name only. */
const packageFile = (ecosystem, source, ranked, versionsOf, normalize) => ({
  ecosystem,
  source,
  fetchedAt: date,
  seedTop: SEED_TOP,
  seed: ranked.slice(0, SEED_TOP).map(({ name, versions }) => [normalize(name), versions]),
  resolved: ranked.slice(SEED_TOP, SEED_TOP + RESOLVED_TAIL).map(({ name }) => normalize(name)),
  versionsOf,
});

const ecosystePage = async (registry, page) => {
  const rows = await get(`https://packages.ecosyste.ms/api/v1/registries/${registry}/packages?sort=downloads&order=desc&per_page=100&page=${page}`);
  return (rows ?? []).map((row) => row.name);
};

const rankedFromEcosystems = async (registry, count) => {
  const names = [];
  for (let page = 1; names.length < count; page++) {
    const batch = await ecosystePage(registry, page);
    if (batch.length === 0) break;
    for (const name of batch) if (!names.includes(name)) names.push(name);
  }
  return names.slice(0, count);
};

const versionsFor = async (names, width, fetchVersions, keep) => {
  const entries = await each(names.slice(0, keep), width, async (name) => ({ name, versions: await fetchVersions(name) }));
  const tail = names.slice(keep).map((name) => ({ name, versions: [] }));
  return [...entries.filter((entry) => entry.versions !== null), ...tail];
};

const builders = {
  async npm() {
    const names = await rankedFromEcosystems('npmjs.org', SEED_TOP + RESOLVED_TAIL);
    const ranked = await versionsFor(
      names,
      6,
      async (name) => {
        const packument = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json' });
        return packument === null ? null : Object.keys(packument.versions ?? {});
      },
      SEED_TOP,
    );
    write('npm.json', packageFile('npm', 'packages.ecosyste.ms npmjs.org by downloads, versions from registry.npmjs.org', ranked, 'registry.npmjs.org', normalizeNpm));
  },
  async pypi() {
    const top = await get('https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json');
    const names = top.rows.slice(0, SEED_TOP + RESOLVED_TAIL).map((row) => row.project);
    const ranked = await versionsFor(
      names,
      6,
      async (name) => {
        const project = await get(`https://pypi.org/pypi/${name}/json`);
        return project === null ? null : Object.keys(project.releases ?? {});
      },
      SEED_TOP,
    );
    write('pypi.json', packageFile('pypi', 'hugovk/top-pypi-packages (PyPI download log, 30 days), versions from pypi.org', ranked, 'pypi.org', normalizePypi));
  },
  async crates() {
    const names = [];
    for (let page = 1; names.length < SEED_TOP + RESOLVED_TAIL; page++) {
      const batch = await get(`https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=${page}`);
      names.push(...batch.crates.map((crate) => crate.name));
      await sleep(1100);
    }
    const indexPath = (name) => {
      const lower = name.toLowerCase();
      if (lower.length <= 2) return `${lower.length}/${lower}`;
      if (lower.length === 3) return `3/${lower[0]}/${lower}`;
      return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
    };
    const ranked = await versionsFor(
      names.slice(0, SEED_TOP + RESOLVED_TAIL),
      6,
      async (name) => {
        const index = await get(`https://index.crates.io/${indexPath(name)}`, { text: true });
        return index === null ? null : index.split('\n').filter(Boolean).map((line) => JSON.parse(line).vers);
      },
      SEED_TOP,
    );
    write('crates.json', packageFile('crates', 'crates.io /api/v1/crates sorted by downloads, versions from index.crates.io', ranked, 'index.crates.io', normalizeCrate));
  },
  async rubygems() {
    const names = await rankedFromEcosystems('rubygems.org', SEED_TOP + RESOLVED_TAIL);
    const ranked = await versionsFor(
      names,
      6,
      async (name) => {
        const versions = await get(`https://rubygems.org/api/v1/versions/${name}.json`);
        return versions === null ? null : versions.map((version) => version.number);
      },
      SEED_TOP,
    );
    write('rubygems.json', packageFile('rubygems', 'packages.ecosyste.ms rubygems.org by downloads, versions from rubygems.org', ranked, 'rubygems.org', normalizeGem));
  },
  async homebrew() {
    const analytics = await get('https://formulae.brew.sh/api/analytics/install/30d.json');
    const formulae = await get('https://formulae.brew.sh/api/formula.json');
    const current = new Map(formulae.map((formula) => [formula.name, formula.versions?.stable ?? null]));
    const names = analytics.items.map((item) => item.formula).filter((name) => current.has(name));
    const ranked = names.slice(0, SEED_TOP + RESOLVED_TAIL).map((name) => ({ name, versions: current.get(name) === null ? [] : [current.get(name)] }));
    write('homebrew.json', packageFile('homebrew', 'formulae.brew.sh analytics install/30d and formula.json (one current version per formula)', ranked, 'formulae.brew.sh', normalizeNpm));
  },
  go() {
    write('go.json', { ecosystem: 'go', source: null, fetchedAt: date, seedTop: 0, seed: [], resolved: [], note: 'The Go module proxy publishes no download counts: every Go module is private.' });
  },
  maven() {
    write('maven.json', { ecosystem: 'maven', source: null, fetchedAt: date, seedTop: 0, seed: [], resolved: [], note: 'Maven Central publishes no download counts: every Maven artifact is private.' });
  },
  async programs() {
    const commit = (await get('https://api.github.com/repos/tldr-pages/tldr/commits/main', { accept: 'application/vnd.github+json' })).sha;
    const work = mkdtempSync(join(tmpdir(), 'oars-tldr-'));
    try {
      const archive = join(work, 'tldr.tar.gz');
      const response = await fetch(`https://codeload.github.com/tldr-pages/tldr/tar.gz/${commit}`, { headers: { 'user-agent': AGENT } });
      if (!response.ok) throw new Error(`${response.status} tldr tarball`);
      writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      const extracted = join(work, 'out');
      mkdirSync(extracted);
      const untar = spawnSync('tar', ['-xzf', archive, '-C', extracted, '--force-local', '--wildcards', '*/pages/*'], { stdio: 'inherit' });
      if (untar.status !== 0) throw new Error('tar failed');
      const root = join(extracted, readdirSync(extracted)[0], 'pages');
      write('programs.json', { source: 'tldr-pages', commit, fetchedAt: date, programs: readTldr(root) });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  async models() {
    const providers = await get('https://models.dev/api.json');
    const ids = new Set();
    for (const provider of Object.values(providers)) for (const id of Object.keys(provider.models ?? {})) ids.add(id.toLowerCase());
    write('models.json', { source: 'models.dev/api.json', fetchedAt: date, ids: [...ids].sort() });
  },
  async harness() {
    const packages = { 'claude-code': '@anthropic-ai/claude-code', codex: '@openai/codex', 'gemini-cli': '@google/gemini-cli' };
    const harnesses = {};
    for (const [harness, name] of Object.entries(packages)) {
      const packument = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json' });
      harnesses[harness] = Object.keys(packument.versions);
    }
    write('harness.json', { source: 'registry.npmjs.org (each harness CLI package)', fetchedAt: date, harnesses });
  },
};

/** tldr pages to `{ program: { subs, flags } }`: a page name `git-commit` is the subcommand `commit` of `git` when a `git` page exists. */
function readTldr(root) {
  const pages = new Map();
  for (const platform of readdirSync(root)) {
    if (!/^(common|linux|osx|windows)$/.test(platform)) continue;
    for (const file of readdirSync(join(root, platform))) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._+-]*$/.test(name)) continue;
      pages.set(name, [...(pages.get(name) ?? []), readFileSync(join(root, platform, file), 'utf8')]);
    }
  }
  const programs = {};
  const entry = (program) => (programs[program] ??= { subs: new Set(), flags: new Set() });
  for (const [name, texts] of pages) {
    const dash = name.indexOf('-');
    const parent = dash > 0 && pages.has(name.slice(0, dash)) ? name.slice(0, dash) : null;
    const owner = entry(parent ?? name);
    if (parent !== null) owner.subs.add(name.slice(dash + 1));
    entry(name);
    for (const text of texts) {
      for (const line of text.split('\n')) {
        const match = /^`(.+)`$/.exec(line.trim());
        if (match === null) continue;
        // Current pages write a flag as `{{[-i|--ignore-case]}}`: both spellings are flags, and every other placeholder is a value to drop.
        const spellings = [...match[1].matchAll(/\{\{\[([^\]]*)\]\}\}/g)].flatMap((found) => (found[1] ?? '').split('|'));
        const command = `${spellings.join(' ')} ${match[1].replace(/\{\{.*?\}\}/g, ' ')}`;
        for (const token of command.split(/\s+/)) {
          const name = /^(--?[A-Za-z][\w-]*)/.exec(token)?.[1];
          if (name !== undefined && name.length <= 40) owner.flags.add(name);
        }
      }
    }
  }
  return Object.fromEntries(
    Object.keys(programs)
      .sort()
      .map((program) => [program, { subs: [...programs[program].subs].sort(), flags: [...programs[program].flags].sort() }]),
  );
}

const run = async () => {
  for (const [name, build] of Object.entries(builders)) {
    if (only !== null && !only.includes(name)) continue;
    console.log(`building ${name}`);
    await build();
  }
  const files = readdirSync(OUT).filter((file) => file.endsWith('.json') && file !== 'manifest.json').sort();
  const manifest = { snapshotDate: date, files: {} };
  for (const file of files) {
    const bytes = readFileSync(join(OUT, file));
    manifest.files[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  write('manifest.json', manifest);
};

await run();
