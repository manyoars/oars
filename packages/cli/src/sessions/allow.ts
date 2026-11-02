// What `--allow` accepts. An entry names project folders by one of:
//   a folder or slug       `~/work/app` or `-home-me-work-app`: that one project folder
//   a folder prefix        `~/work/` (trailing slash): that folder and everything under it
//   a glob                 `*-work-*`, `C:\work\app-*`: `*` any run of characters, `?` one character
// A path is matched through its slug, because Claude Code names a project folder after its working directory with every
// non-alphanumeric character as `-`.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';

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

export const compileAllow = (entries: readonly string[]): Allow => {
  const compiled = entries.map((entry) => ({ entry, matches: matcherOf(expandHome(entry)) }));
  return {
    allows: (name) => compiled.some((item) => item.matches(name)),
    unmatched: (names) => compiled.filter((item) => !names.some((name) => item.matches(name))).map((item) => item.entry),
  };
};

/** One entry per line; blank lines and lines starting with `#` are skipped. */
export const parseAllowList = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

export const requireEntries = (entries: readonly string[]): void => {
  if (entries.length === 0) {
    throw new CliError('Nothing to read: pass at least one --allow <folder> or --allow-file <list>. Nothing is read from a folder you have not named.', ExitCode.USAGE, 'usage');
  }
};
