// Packages as a capture stores them (pool vocabulary spec Sections 1.2 and 1.3, t827): a name a transcript shows, resolved to `<ecosystem>:<name>` in the
// registry's own spelling. Resolving is a check of shape only, since capture asks no registry: a name that cannot be told from a path, a flag, a URL, or a
// masked word is not a package and stores nothing. Whether the name is public is the projection's question (`projectPackage`), asked at deposit.

import type { PullEcosystem, ToolPackage, ToolPull } from './schema.js';

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

/** A published version: dotted numbers with an optional pre-release or build tail, and Go's leading `v`. A range (`^1.2`, `>=2`), a tag (`latest`), or a mask is no version. */
const EXACT_VERSION = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.+-]+)?$/;

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
 * The packages one call installs or runs, each marked `first` when no earlier call of the session named that package at that version. `seen` is the
 * session's running set, so the caller passes the same one for every call in order. A version that fails on first try still counts: the mark is made
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
