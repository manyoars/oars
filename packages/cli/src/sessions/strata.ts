// The stack strata a capture stores (pool vocabulary spec Sections 1.1 and 7): language and its share of the touched files, the repository's file
// count by order of magnitude, the framework a resolved package shows, and how many steps only looked. Every value is a member of a closed list or a count,
// so no path, package name, or program text is kept. The language and share projections are here; the rest that gate these at deposit are in `projection.ts`.

import { LANGUAGE_OF_EXTENSION, LANGUAGES, type RepoSize } from './public-vocabulary.js';
import { LANGUAGE_SHARES, type LanguageShare, type RepoFilesBucket, type Strata } from './schema.js';
import type { CanonicalAction } from './actions.js';

/** The steps that only look at the code or the web. `file.read`, `file.search`, `web.search`, and `web.fetch`; a shell step is not counted, because what it does is not known from its action. */
const EXPLORE_ACTIONS: ReadonlySet<CanonicalAction> = new Set<CanonicalAction>(['file.read', 'file.search', 'web.search', 'web.fetch']);

/** How many of the given steps only look. */
export const exploreCount = (actions: readonly CanonicalAction[]): number => actions.filter((action) => EXPLORE_ACTIONS.has(action)).length;

/**
 * A language's share of the touched files: absent, incidental (under 10 percent), secondary (10 up to 50), primary (50 and over). The lower edge is inclusive.
 * Integers are compared, not a quotient, so 1 of 10 files is exactly 10 percent.
 */
export const languageShareBucket = (files: number, total: number): LanguageShare => {
  if (files <= 0 || total <= 0) return '0';
  if (files * 100 < total * 10) return 'under-10';
  return files * 100 < total * 50 ? '10-50' : 'over-50';
};

/** The repository's size bucket (`repoSizeOf`) as the pool's `repoFiles` bucket: both cut at 100, 1000, 10000, and 100000 with the lower edge inclusive. */
const REPO_FILES_OF_SIZE: ReadonlyMap<RepoSize, RepoFilesBucket> = new Map<RepoSize, RepoFilesBucket>([
  ['xs', 'under-100'],
  ['s', '100-1k'],
  ['m', '1k-10k'],
  ['l', '10k-100k'],
  ['xl', 'over-100k'],
]);
export const repoFilesBucketOf = (size: RepoSize | null): RepoFilesBucket | null => (size === null ? null : (REPO_FILES_OF_SIZE.get(size) ?? null));

/**
 * A package the vocabulary marks as a framework, by `<ecosystem>:<name>` as `resolveName` writes it, to the framework's name in `FRAMEWORKS`. A package
 * is not a program or a file, so this is the one source of `framework` that names a registry entry.
 */
export const FRAMEWORK_OF_PACKAGE: ReadonlyMap<string, string> = new Map([
  ['npm:vite', 'vite'],
  ['npm:vitest', 'vitest'],
  ['npm:astro', 'astro'],
  ['npm:next', 'next'],
  ['npm:nuxt', 'nuxt'],
  ['npm:svelte', 'svelte'],
  ['npm:@angular/core', 'angular'],
  ['npm:tailwindcss', 'tailwind'],
  ['npm:jest', 'jest'],
  ['npm:playwright', 'playwright'],
  ['npm:@playwright/test', 'playwright'],
  ['npm:wrangler', 'cloudflare-workers'],
  ['pypi:django', 'django'],
  ['rubygems:rails', 'rails'],
]);

/** The language of one touched path: the vocabulary's name for its extension, else `other`; null for a path with no extension, which shows no language. A dotfile (`.gitignore`) has none: its only dot leads the name. */
const languageOfPath = (path: string): string | null => {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  if (base.lastIndexOf('.') <= 0) return null;
  return LANGUAGE_OF_EXTENSION.get(base.split('.').pop()?.toLowerCase() ?? '') ?? 'other';
};

/** The strata of a file's evidence but `explore`, which the caller counts for the file and for each prompt. Files are counted, not touches: a path read ten times is one. */
export const strataOf = (evidence: { paths: readonly string[]; packages: readonly string[]; size: RepoSize | null }): Omit<Strata, 'explore'> => {
  const counts = new Map<string, number>();
  let total = 0;
  for (const path of new Set(evidence.paths)) {
    const language = languageOfPath(path);
    if (language === null) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
    total += 1;
  }
  return {
    languages: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([language, files]) => ({ language, share: languageShareBucket(files, total) })),
    repoFiles: repoFilesBucketOf(evidence.size),
    frameworks: [...new Set(evidence.packages.flatMap((name) => FRAMEWORK_OF_PACKAGE.get(name) ?? []))].sort(),
  };
};

/** A stored language as it pools: a member of the pinned list, else `other`. */
export const projectLanguage = (stored: string): string => (LANGUAGES.has(stored) ? stored : 'other');

/** A stored share bucket as it pools: itself when it is one of the four, else null (no bucket is guessed from a value this code does not know). */
export const projectLanguageShare = (stored: string): LanguageShare | null => LANGUAGE_SHARES.find((bucket) => bucket === stored) ?? null;
