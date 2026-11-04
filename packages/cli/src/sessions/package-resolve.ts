// Packages as a capture stores them (pool vocabulary spec Sections 1.2 and 1.3): a name a transcript shows, resolved to `<ecosystem>:<name>` in the
// registry's own spelling. Resolving is a check of shape only, since capture asks no registry: a name that cannot be told from a path, a flag, a URL, or a
// masked word is not a package and stores nothing. Whether the name is public is the projection's question (`projectPackage`), asked at deposit.

import type { Redactor } from './redact.js';
import type { PullEcosystem, ToolManifest, ToolPackage, ToolPull } from './schema.js';

/** The registry's own normalization (spec Section 1.3): npm lowercases, PyPI folds `-`, `_`, and `.`, crates.io folds `-` and `_`. */
export const NORMALIZE: ReadonlyMap<string, (name: string) => string> = new Map<string, (name: string) => string>([
  ['npm', (name) => name.toLowerCase()],
  ['pypi', (name) => name.toLowerCase().replace(/[-_.]+/g, '-')],
  ['crates', (name) => name.toLowerCase().replace(/_/g, '-')],
  ['rubygems', (name) => name],
  ['homebrew', (name) => name.toLowerCase()],
]);

/** A capture ecosystem to the vocabulary's. `skill`, `plugin`, and `mcp` are not package registries and are absent. */
const ECOSYSTEM_OF: ReadonlyMap<PullEcosystem, string> = new Map<PullEcosystem, string>([
  ['npm', 'npm'],
  ['pypi', 'pypi'],
  ['cargo', 'crates'],
  ['gem', 'rubygems'],
  ['brew', 'homebrew'],
  ['go', 'go'],
]);

/** What each registry accepts as a name. A scoped npm name is the only one with a slash besides a Go module path, so `owner/repo` (a GitHub shorthand) fails. */
const NAME_SHAPE: ReadonlyMap<string, RegExp> = new Map<string, RegExp>([
  ['npm', /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i],
  ['pypi', /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i],
  ['crates', /^[a-z][a-z0-9_-]*$/i],
  ['rubygems', /^[a-z0-9][a-z0-9._-]*$/i],
  ['homebrew', /^[a-z0-9][a-z0-9@+._-]*$/i],
  ['go', /^[a-z0-9.-]+\.[a-z0-9.-]+\/[\w.~/-]+$/i],
]);

/** A published version: three or four dotted numbers with an optional pre-release or build tail, and Go's leading `v`. A bare `1` or `2.31` is a range to its registry, so like a range (`^1.2`, `>=2`), a tag (`latest`), or a mask it is no version. */
const EXACT_VERSION = /^v?\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.+-]+)?$/;

/** A name in an ecosystem of the vocabulary, spelled as the registry spells it; null when it is not shaped like one. */
export const resolveName = (ecosystem: string, name: string): string | null => {
  const shape = NAME_SHAPE.get(ecosystem);
  if (shape === undefined || !shape.test(name)) return null;
  return `${ecosystem}:${NORMALIZE.get(ecosystem)?.(name) ?? name}`;
};

/** One pull as the `package` and `packageVersion` it names, or null when it names no package. */
export const resolvePull = (pull: ToolPull): Omit<ToolPackage, 'first'> | null => {
  const ecosystem = ECOSYSTEM_OF.get(pull.ecosystem);
  const resolved = ecosystem === undefined ? null : resolveName(ecosystem, pull.name);
  if (resolved === null) return null;
  return { package: resolved, packageVersion: pull.version !== null && EXACT_VERSION.test(pull.version) ? pull.version : null };
};

/**
 * The packages one call installs or runs, each marked `first` when no earlier call of the transcript file named that package at that version. `seen` is the
 * file's running set, so the caller passes the same one for every call in order. A version that fails on first try still counts: the mark is made
 * from the command, before its result is known.
 */
export const packagesOf = (pulls: readonly ToolPull[], seen: Set<string>): ToolPackage[] => {
  const packages = new Map<string, ToolPackage>();
  for (const pull of pulls) {
    const resolved = resolvePull(pull);
    if (resolved === null) continue;
    const key = `${resolved.package}\n${resolved.packageVersion ?? ''}`;
    if (packages.has(key)) continue;
    packages.set(key, { ...resolved, first: !seen.has(key) });
  }
  for (const key of packages.keys()) seen.add(key);
  return [...packages.values()];
};

// Manifests: what a transcript shows of a dependency file, read as lines, since an edit shows a fragment and no parser can take one. A name comes out only
// when its line has a dependency's shape, so the other keys of a manifest (a script, an engine, a package's own `version`) are not read as packages.

export type ManifestFile = ToolManifest['file'];

const MANIFEST_ECOSYSTEM: ReadonlyMap<ManifestFile, string> = new Map<ManifestFile, string>([
  ['package.json', 'npm'],
  ['requirements.txt', 'pypi'],
  ['Cargo.toml', 'crates'],
]);

/** A folder that holds code a project installed: a manifest inside it belongs to a dependency, and the session did not choose it. */
const DEPENDENCY_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'site-packages', '.venv', 'venv', '.cargo', 'bower_components']);

/**
 * The manifest a path names, by its basename: `requirements-dev.txt` is a requirements file, `Cargo.toml` is exact. A path with a `node_modules`, `vendor`, `site-packages`,
 * `.venv`, `venv`, `.cargo`, or `bower_components` folder (in any case) names none, since that manifest is a dependency's own. Not covered: pyproject.toml, go.mod, Gemfile, pom.xml.
 */
export const manifestFileOf = (path: string): ManifestFile | null => {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.some((part) => DEPENDENCY_FOLDERS.has(part.toLowerCase()))) return null;
  const base = parts.pop() ?? '';
  if (base === 'package.json' || base === 'Cargo.toml') return base;
  return /^requirements(?:[-_.][\w.-]+)?\.txt$/.test(base) ? 'requirements.txt' : null;
};

/** A Read result numbers its lines (`    12→text`); an edit's text does not. */
const withoutLineNumbers = (line: string): string => line.replace(/^\s*\d+(?:→|\t)/, '');

const NODE_DEPENDENCY_KEYS: ReadonlySet<string> = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
/** A range, a pin, or a tag. A `file:`, `workspace:`, `npm:` alias, URL, or git value names no registry package. */
const NODE_VERSION = /^(?:[~^<>=]*\s*v?\d[\w.*+-]*|\*|latest|next)(?:\s.*)?$/i;
/** Keys that hold a version-shaped value and are not dependencies, for text that shows no section header. */
const NOT_NODE_DEPENDENCIES: ReadonlySet<string> = new Set(['name', 'description', 'main', 'version', 'node', 'npm', 'yarn', 'pnpm', 'tag']);

const nodeNames = (lines: readonly string[]): string[] => {
  // A whole file opens with `{`, so its top-level values are no dependencies. A fragment stays null until a section header is seen: an edit may hold dependency lines alone.
  let active: boolean | null = lines.find((line) => line.trim() !== '')?.trim() === '{' ? false : null;
  const names: string[] = [];
  for (const line of lines) {
    const section = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(line)?.[1];
    if (section !== undefined) active = NODE_DEPENDENCY_KEYS.has(section);
    else if (/^\s*\},?\s*$/.test(line)) active = false;
    else if (active !== false) {
      const entry = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/.exec(line);
      if (entry !== null && NODE_VERSION.test(entry[2] ?? '') && (active === true || !NOT_NODE_DEPENDENCIES.has(entry[1] ?? ''))) names.push(entry[1] ?? '');
    }
  }
  return names;
};

/** A line that ends in an archive, before any environment marker, names a file, as a path does. */
const ARCHIVE = /\.(?:whl|tar\.gz|tgz|tar\.bz2|zip|egg)$/i;

const pythonNames = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => {
    const text = line.replace(/(?:^|\s)#.*$/, '').trim();
    if (text === '' || text.startsWith('-') || text.includes('://') || ARCHIVE.test(text.split(';')[0]?.trim() ?? '')) return [];
    const name = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(?:$|[=<>!~;@,])/.exec(text)?.[1];
    return name === undefined ? [] : [name];
  });

const CARGO_DEPENDENCY_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies$/;
const CARGO_DEPENDENCY_ENTRY = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z][\w-]*)$/;
const CARGO_VERSION = /^[~^<>=]*\s*\d[\w.*+-]*$|^\*$/;
const NOT_CARGO_DEPENDENCIES: ReadonlySet<string> = new Set(['version', 'name', 'edition', 'rust-version', 'resolver', 'license', 'authors', 'description', 'readme', 'repository', 'homepage', 'documentation', 'publish', 'opt-level', 'keywords', 'categories', 'exclude', 'include', 'build', 'links']);

const cargoNames = (lines: readonly string[]): string[] => {
  // null until a table header is seen, as for package.json.
  let inDependencies: boolean | null = null;
  // A dependency written as its own table is known by its keys, which follow the header: it waits here until the next header or the end of the text.
  let pending: string | null = null;
  const names: string[] = [];
  const settle = (): void => {
    if (pending !== null) names.push(pending);
    pending = null;
  };
  for (const line of lines) {
    const table = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)?.[1]?.replace(/\s/g, '');
    if (table !== undefined) {
      settle();
      pending = CARGO_DEPENDENCY_ENTRY.exec(table)?.[1] ?? null;
      inDependencies = CARGO_DEPENDENCY_TABLE.test(table);
    } else if (pending !== null) {
      // A `path` or `git` key makes the table a source and no registry crate; `package` names the real crate behind an alias.
      if (/^\s*(?:path|git)\s*=/.test(line)) pending = null;
      else pending = /^\s*package\s*=\s*"([^"]+)"/.exec(line)?.[1] ?? pending;
    } else if (inDependencies !== false) {
      const shared = /^\s*([A-Za-z][\w-]*)\.workspace\s*=\s*true\b/.exec(line)?.[1];
      const entry = /^\s*([A-Za-z][\w-]*)\s*=\s*(.+?)\s*$/.exec(line);
      // A comment after the closing quote or brace is not part of the value.
      const value = (entry?.[2] ?? '').replace(/(?<=["}])\s+#.*$/, '');
      const text = /^"([^"]*)"$/.exec(value)?.[1];
      // An inline table holding `path` or `git` is a source and no registry crate; `package` names the real crate behind an alias.
      const named = text !== undefined ? CARGO_VERSION.test(text) : /^\{.*\b(?:version|workspace)\s*=/.test(value) && !/\b(?:path|git)\s*=/.test(value);
      const real = /\bpackage\s*=\s*"([^"]+)"/.exec(value)?.[1];
      if (shared !== undefined) names.push(shared);
      else if (entry !== null && named && (inDependencies === true || !NOT_CARGO_DEPENDENCIES.has(entry[1] ?? ''))) names.push(real ?? entry[1] ?? '');
    }
  }
  settle();
  return names;
};

/**
 * The packages a manifest text names, as `<ecosystem>:<name>`, each once, sorted. A name the redactor changes is a secret or a mask and is dropped as it was
 * written, before resolving folds its case: the redactor's rules are case-sensitive, so a folded key would pass them.
 */
export const manifestNames = (file: ManifestFile, text: string, redact: Redactor): string[] => {
  const lines = text.split(/\r?\n/).map(withoutLineNumbers);
  const found = file === 'package.json' ? nodeNames(lines) : file === 'requirements.txt' ? pythonNames(lines) : cargoNames(lines);
  const ecosystem = MANIFEST_ECOSYSTEM.get(file) ?? '';
  return [...new Set(found.filter((name) => redact(name) === name).flatMap((name) => resolveName(ecosystem, name) ?? []))].sort();
};

/** The names an edit adds and removes: those only in the new text, and those only in the old. A version change moves neither. */
export const manifestDelta = (file: ManifestFile, before: string, after: string, redact: Redactor): { added: string[]; removed: string[] } => {
  const was = manifestNames(file, before, redact);
  const now = manifestNames(file, after, redact);
  return { added: now.filter((name) => !was.includes(name)), removed: was.filter((name) => !now.includes(name)) };
};
