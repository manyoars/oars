// What `--allow` accepts. An entry names project folders by one of:
//   a folder or slug       `~/work/app` or `-home-me-work-app`: that one project folder
//   a folder prefix        `~/work/` (trailing slash): that folder and everything under it
//   a glob                 `*-work-*`, `C:\work\app-*`: `*` any run of characters, `?` one character
// A path is matched through its slug, because Claude Code names a project folder after its working directory with every
// non-alphanumeric character as `-`. An entry that starts with `!` (what `--deny` saves) keeps the folders it names out, whatever
// else names them. With no entry that is not a denial, every folder is on the list: the default is every folder.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** A leading `~` is the home folder, expanded here because a quoted entry or one read from a list file reaches us unexpanded by any shell. */
export const expandHome = (entry: string): string => (/^~(?:[\\/]|$)/.test(entry) ? homedir() + entry.slice(1) : entry);

/** Claude Code names a project folder after its working directory with every non-alphanumeric character as `-`. */
export const slugOf = (folder: string): string => resolve(expandHome(folder)).replace(/[^A-Za-z0-9]/g, '-');

const GLOB = /[*?]/;

/** A glob over a path or slug, as an anchored expression over slugs: separators become `-`, wildcards stay wildcards. */
const globPattern = (entry: string): RegExp => {
  // Every character that is neither alphanumeric nor a wildcard becomes the slug's `-`; then the wildcards become expressions.
  const body = entry.replace(/[^A-Za-z0-9*?]/g, '-').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
};

/** The test a project folder name must pass for one entry. */
const matcherOf = (entry: string): ((name: string) => boolean) => {
  if (GLOB.test(entry)) {
    const pattern = globPattern(entry);
    return (name) => pattern.test(name);
  }
  if (/[\\/]$/.test(entry)) {
    const prefix = slugOf(entry);
    // `resolve` drops the trailing separator, so the prefix is the folder itself; a project under it extends the slug with `-`.
    return (name) => name === prefix || name.startsWith(`${prefix}-`);
  }
  const slug = slugOf(entry);
  return (name) => name === entry || name === slug;
};

export interface Allow {
  /** Whether a project folder name is on the allowlist. */
  allows: (name: string) => boolean;
  /** The entries that matched none of `names`. */
  unmatched: (names: readonly string[]) => string[];
}

/** The prefix `--deny` saves an entry under. */
export const DENY = '!';

const isDenial = (entry: string): boolean => entry.startsWith(DENY);

export const denialOf = (entry: string): string => `${DENY}${entry}`;

export const compileAllow = (entries: readonly string[]): Allow => {
  const compiled = entries.filter((entry) => !isDenial(entry)).map((entry) => ({ entry, matches: matcherOf(expandHome(entry)) }));
  const denied = entries.filter(isDenial).map((entry) => matcherOf(expandHome(entry.slice(DENY.length))));
  return {
    allows: (name) => (compiled.length === 0 || compiled.some((item) => item.matches(name))) && !denied.some((matches) => matches(name)),
    unmatched: (names) => compiled.filter((item) => !names.some((name) => item.matches(name))).map((item) => item.entry),
  };
};

/**
 * Whether the named entries only lift saved denials: each is denied in `saved`, and `saved` names no folder. On every-folder scope such
 * an `--allow` drops the denial and adds nothing, because adding the entry would narrow every later run to it.
 */
const liftsOnly = (saved: readonly string[], named: readonly string[]): boolean =>
  named.length > 0 && saved.every(isDenial) && named.every((entry) => saved.includes(denialOf(entry)));

/**
 * The list a deposit saves: the saved entries and the given ones, where naming a folder again with `--allow` lifts the denial of exactly
 * that entry. A denial is kept until then, so a later `--allow` of a wider prefix cannot read a denied folder.
 */
export const mergeAllow = (saved: readonly string[], given: readonly string[]): string[] => {
  const kept = saved.filter((entry) => !(isDenial(entry) && given.includes(entry.slice(DENY.length))));
  const added = liftsOnly(saved, given.filter((entry) => !isDenial(entry))) ? given.filter(isDenial) : given;
  return [...new Set([...kept, ...added])];
};

/** What one deposit reads: the folders it names, else the saved list (empty is every folder), less every denial saved or given. */
export const runAllow = (saved: readonly string[], given: readonly string[]): string[] => {
  const merged = mergeAllow(saved, given);
  const named = given.filter((entry) => !isDenial(entry));
  return named.length === 0 || liftsOnly(saved, named) ? merged : [...named, ...merged.filter(isDenial)];
};

/** One entry per line; blank lines and lines starting with `#` are skipped. */
export const parseAllowList = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
