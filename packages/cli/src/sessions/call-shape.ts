// What a call touched, in shape and never in value (t870): the class of its target and the classes of its arguments. Both are computed at capture, from
// the path and the input that only the extractor holds, and stored as closed-list members. The path, the argument values, and the base name never leave it.
import { PUBLIC_FLAGS, PUBLIC_SUBCOMMANDS } from './public-vocabulary.js';
import type { TargetBase } from './schema.js';

/** Where a path target sits in the project, as a closed list. `none` is a call with no path target (a shell call, a search, a fetch). */
export const TARGET_CLASSES = ['source', 'test', 'config', 'doc', 'lockfile', 'generated', 'data', 'none', 'other'] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

/** What an argument holds, as a closed list: a call's arguments are the sorted set of these. `none` is a call with no arguments. */
export const ARG_CLASSES = ['path', 'url', 'pattern', 'command', 'number', 'flag', 'text', 'none'] as const;
export type ArgClass = (typeof ARG_CLASSES)[number];

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter((word) => word !== ''));

const LOCKFILES = words(
  'package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lockb bun.lock cargo.lock poetry.lock pipfile.lock uv.lock gemfile.lock composer.lock go.sum gradle.lockfile packages.lock.json podfile.lock pubspec.lock mix.lock flake.lock',
);
const GENERATED_DIRS = words('dist build out node_modules .next .nuxt .astro .svelte-kit coverage target __generated__ generated .turbo .cache __pycache__ vendor');
const TEST_DIRS = words('test tests __tests__ spec specs e2e __mocks__ fixtures testdata cypress');
const DOC_DIRS = words('docs doc documentation');
const SOURCE_EXTENSIONS = words(
  'ts tsx mts cts js jsx mjs cjs py pyi java kt kts go rs rb php cs c h cc cpp hpp swift scala sh bash zsh ps1 psm1 sql astro vue svelte css scss sass less html htm lua dart ex exs erl clj hs ml r jl pl zig groovy gradle',
);
const DOC_EXTENSIONS = words('md mdx rst txt adoc org tex');
const CONFIG_EXTENSIONS = words('json jsonc json5 yaml yml toml ini cfg conf properties env plist editorconfig xml');
const DATA_EXTENSIONS = words('csv tsv ndjson jsonl parquet avro arrow db sqlite sqlite3 log xlsx xls dat bin pkl');
const CONFIG_BASENAMES = words('dockerfile makefile justfile procfile gemfile rakefile pom.xml build.gradle settings.gradle .gitignore .gitattributes .npmrc .nvmrc .prettierrc .eslintrc .dockerignore .editorconfig');
const DOC_BASENAMES = words('readme license licence changelog contributing notice authors codeowners');

const TEST_NAME = /(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)|(?:_test|_spec|Test|Tests|Spec)\.[a-z]+$/;
const GENERATED_NAME = /\.(?:min\.(?:js|css)|d\.ts|map|generated\.[a-z]+|pb\.go|g\.dart)$/;

/**
 * The class of a path target, from the base that hashed it and the path's own suffix. A call with no path target (`base` null) is `none`; the order below is the order a path is asked,
 * so a lockfile is never `config` and a `tests/data.json` is `test`. The mapping is pinned in `call-shape.test.ts`. `path` is the key the target is hashed on (relative to the repository or the cwd, never the absolute path), so the folders above a repository do not decide the class; it is read here and goes no further.
 */
export const targetClassOf = (path: string | undefined, base: TargetBase | null): TargetClass => {
  if (base === null || path === undefined || path === '') return 'none';
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  const name = parts.at(-1) ?? '';
  const lower = name.toLowerCase();
  const dirs = parts.slice(0, -1).map((part) => part.toLowerCase());
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : lower.startsWith('.') ? lower.slice(1) : '';
  if (LOCKFILES.has(lower)) return 'lockfile';
  if (dirs.some((dir) => GENERATED_DIRS.has(dir)) || GENERATED_NAME.test(lower)) return 'generated';
  if (dirs.some((dir) => TEST_DIRS.has(dir)) || TEST_NAME.test(name)) return 'test';
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  if (DOC_EXTENSIONS.has(extension) || DOC_BASENAMES.has(stem) || dirs.some((dir) => DOC_DIRS.has(dir))) return 'doc';
  if (CONFIG_BASENAMES.has(lower) || /^\.[a-z0-9_.-]*(?:rc|ignore)(?:\.[a-z]+)?$/.test(lower) || /\.config\.[a-z]+$/.test(lower) || /^tsconfig[a-z0-9.-]*\.json$/.test(lower) || /^\.env(?:\.|$)/.test(lower)) return 'config';
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';
  if (DATA_EXTENSIONS.has(extension)) return 'data';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  return 'other';
};

const PATH_ARGS = words('file_path notebook_path path cwd workdir directory dir filepath filename file');
const URL_ARGS = words('url uri href');
const PATTERN_ARGS = words('pattern regex regexp glob include exclude');
const COMMAND_ARGS = words('command cmd script');
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

const argClassOfEntry = (key: string, value: unknown): ArgClass | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'flag';
  const lower = key.toLowerCase();
  if (PATH_ARGS.has(lower)) return 'path';
  if (URL_ARGS.has(lower) || (typeof value === 'string' && URL_VALUE.test(value))) return 'url';
  if (PATTERN_ARGS.has(lower)) return 'pattern';
  if (COMMAND_ARGS.has(lower)) return 'command';
  return 'text';
};

/**
 * The classes of a call's arguments, as a sorted set: which of path, URL, pattern, command, number, flag, and text its input holds, or just `none` when it holds no value. A key name
 * gives the class of a string (`file_path` is a path, `pattern` a pattern, `command` a command), a number or a boolean gives its own, and any other value is text. The values are read here and go no further.
 */
export const argClassOf = (input: { readonly [key: string]: unknown }): ArgClass[] => {
  const held = new Set<ArgClass>();
  for (const [key, value] of Object.entries(input)) {
    const kind = argClassOfEntry(key, value);
    if (kind !== null) held.add(kind);
  }
  return held.size === 0 ? ['none'] : ARG_CLASSES.filter((kind) => held.has(kind)).sort();
};

/** The size of a value as written (its length as text, a number's digits included), as a closed list. A boolean and a null have none. */
export const VALUE_SIZES = ['0', '1-8', '9-32', '33-128', '129-512', '513-2k', '2k-8k', 'over-8k'] as const;
export type ValueSize = (typeof VALUE_SIZES)[number];
const SIZE_EDGES = [1, 9, 33, 129, 513, 2049, 8193];

/** How many folders a path value sits below the repository or the working folder; `outside` is an absolute path under neither, so the folders above them are never counted. */
export const PATH_DEPTHS = ['0', '1', '2', '3-4', '5-8', 'over-8', 'outside'] as const;
export type PathDepth = (typeof PATH_DEPTHS)[number];

/** The class of a path value's extension: `none` is a name with none (a folder, a `Makefile`). */
export const EXTENSION_CLASSES = ['source', 'doc', 'config', 'data', 'image', 'none', 'other'] as const;
export type ExtensionClass = (typeof EXTENSION_CLASSES)[number];

/** The kind of the folders a path value names: `root` is a value with no folder part. */
export const DIRECTORY_KINDS = ['root', 'source', 'test', 'doc', 'generated', 'hidden', 'other'] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

/** What a pattern value uses, as a sorted set: `literal` is a pattern that uses none of the rest. A regular expression and a glob share the list. */
export const PATTERN_FEATURES = ['alternation', 'anchor', 'class', 'escape', 'group', 'literal', 'quantifier', 'recursive', 'wildcard'] as const;
export type PatternFeature = (typeof PATTERN_FEATURES)[number];

/** One argument's features (layer 1): its key and the closed-list facts about its value, never the value. `pathDepth`, `extension`, and `dirKind` are on a path argument only, `patternFeatures` on a pattern only. */
export interface ArgFeature {
  key: string;
  valueSize: ValueSize;
  pathDepth?: PathDepth;
  extension?: ExtensionClass;
  dirKind?: DirectoryKind;
  patternFeatures?: PatternFeature[];
}

const SOURCE_DIRS = words('src lib app apps packages pkg cmd internal server client components pages');
const IMAGE_EXTENSIONS = words('png jpg jpeg gif svg webp ico bmp tiff avif');
const GLOB_ARGS = words('glob include exclude');
const DRIVE = /^(?:[a-z]:|~)$/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/]|~)/i;

const sizeOf = (value: unknown): ValueSize => {
  const length = (typeof value === 'string' ? value : JSON.stringify(value)).length;
  return VALUE_SIZES[SIZE_EDGES.filter((edge) => length >= edge).length] ?? 'over-8k';
};

const depthOf = (folders: number): PathDepth => (folders <= 2 ? PATH_DEPTHS[folders] ?? '0' : folders <= 4 ? '3-4' : folders <= 8 ? '5-8' : 'over-8');

/** A path with its `.` and `..` parts resolved, so a path that climbs out of a folder reads as outside it. A Windows drive, a leading `~`, and the leading `//` of a UNC or WSL path stay, as the leading `/` of a posix path does. */
const resolved = (path: string): string => {
  const kept: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (kept.length !== 1 || !DRIVE.test(kept[0] ?? '')) kept.pop();
    } else if (part !== '' && part !== '.') kept.push(part);
  }
  return `${path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : ''}${kept.join('/')}`;
};

/**
 * A path value's folders and name below the base folder, or null for an absolute path outside it. A relative value is taken from the cwd before it is measured, so a relative and an absolute path to one file read the same
 * when the cwd is a folder inside the repository. Only the counts and classes below leave this function.
 */
const partsBelow = (value: string, root: string | undefined, cwd: string | undefined): string[] | null => {
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  const given = value.replace(/\\/g, '/');
  const from = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = ABSOLUTE.test(given) ? resolved(given) : from === undefined || from === '' ? given : resolved(`${from}/${given}`);
  const inside = base !== undefined && base !== '';
  // The root itself (a `.` resolved against a cwd at the root, or its absolute path) has no parts below it, as the same path with a trailing slash has none.
  if (inside && path.toLowerCase() === base.toLowerCase()) return [];
  const below = inside && path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? path.slice(base.length + 1) : ABSOLUTE.test(path) ? null : path;
  return below === null ? null : below.split('/').filter((part) => part !== '' && part !== '.');
};

const extensionOf = (name: string): ExtensionClass => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return 'none';
  const extension = lower.slice(dot + 1);
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';
  if (DOC_EXTENSIONS.has(extension)) return 'doc';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (DATA_EXTENSIONS.has(extension)) return 'data';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'other';
};

const dirKindOf = (folders: readonly string[]): DirectoryKind => {
  const lower = folders.map((folder) => folder.toLowerCase());
  if (lower.length === 0) return 'root';
  if (lower.some((folder) => GENERATED_DIRS.has(folder))) return 'generated';
  if (lower.some((folder) => TEST_DIRS.has(folder))) return 'test';
  if (lower.some((folder) => DOC_DIRS.has(folder))) return 'doc';
  if (lower.some((folder) => folder.startsWith('.'))) return 'hidden';
  if (lower.some((folder) => SOURCE_DIRS.has(folder))) return 'source';
  return 'other';
};

const REGEX_TESTS: readonly (readonly [PatternFeature, RegExp])[] = [
  ['alternation', /(?<!\\)\|/],
  ['anchor', /^\^|(?<!\\)\$$|\\[bAzZ]/],
  ['class', /(?<!\\)\[[^\]]*\]|\\[dwsDWS]/],
  ['escape', /\\[^dwsDWSbAzZ]/],
  ['group', /(?<!\\)\(/],
  ['quantifier', /(?<![\\(])[*+?]|(?<!\\)\{\d+(?:,\d*)?\}/],
  ['wildcard', /(?<!\\)\./],
];
const GLOB_TESTS: readonly (readonly [PatternFeature, RegExp])[] = [
  ['alternation', /\{[^}]*,[^}]*\}/],
  ['class', /\[[^\]]*\]/],
  ['recursive', /\*\*/],
  ['wildcard', /[*?]/],
];

const patternFeaturesOf = (pattern: string, glob: boolean): PatternFeature[] => {
  const used = (glob ? GLOB_TESTS : REGEX_TESTS).filter(([, test]) => test.test(pattern)).map(([feature]) => feature);
  return used.length === 0 ? ['literal'] : [...used].sort();
};

/**
 * The features of each argument of a call (layer 1), sorted by key: its value's size, and for a path its depth below the repository root (else the working folder), its extension class, and its folder kind, and for a pattern what it uses. A Glob call's
 * `pattern` and a `glob`, `include`, or `exclude` argument read as globs; any other pattern as a regular expression. A boolean and a null have no features (a boolean goes as a closed value, `argValuesOf`). The values are read
 * here and go no further: every field is a member of a closed list.
 */
export const argFeaturesOf = (native: string, input: { readonly [key: string]: unknown }, root: string | undefined, cwd?: string): ArgFeature[] =>
  Object.keys(input)
    .sort()
    .flatMap((key): ArgFeature[] => {
      const value = input[key];
      if (value === null || value === undefined || typeof value === 'boolean') return [];
      const kind = argClassOfEntry(key, value);
      const feature: ArgFeature = { key, valueSize: sizeOf(value) };
      if (typeof value === 'string' && kind === 'path') {
        // An absolute path outside the repository root (else the working folder) names folders above it, so its depth is `outside` and its folder kind `other`: only its own name's extension is read.
        const parts = partsBelow(value, root, cwd);
        feature.extension = extensionOf(parts === null ? value.replace(/^.*[\\/]/, '') : (parts.at(-1) ?? ''));
        feature.pathDepth = parts === null ? 'outside' : depthOf(parts.length - 1);
        feature.dirKind = parts === null ? 'other' : dirKindOf(parts.slice(0, -1));
      }
      if (typeof value === 'string' && kind === 'pattern') feature.patternFeatures = patternFeaturesOf(value, native === 'Glob' || GLOB_ARGS.has(key.toLowerCase()));
      return [feature];
    });

/** One argument's closed value (layer 1): a boolean as `true` or `false`, or a member of the closed list its tool pins for the key (`CLOSED_ARG_VALUES`). A value off the list is not one, so it is never sent. */
export interface ArgValue {
  key: string;
  enumValue: string;
}

/** The closed values of a call's arguments, sorted by key: every boolean, and every string its tool's list for the key holds. A custom agent's name is off the list, so it is not here. */
export const argValuesOf = (native: string, input: { readonly [key: string]: unknown }, closed: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>): ArgValue[] =>
  Object.keys(input)
    .sort()
    .flatMap((key): ArgValue[] => {
      const value = input[key];
      if (typeof value === 'boolean') return [{ key, enumValue: String(value) }];
      return typeof value === 'string' && closed.get(native)?.get(key)?.has(value) === true ? [{ key, enumValue: value }] : [];
    });

/** What kind of name a token is: a file's name, a folder's name below the session root, an environment variable's name, a flag's value that is a name, or a custom agent's name. */
export const NAME_KINDS = ['file', 'dir', 'env', 'flag', 'agent'] as const;
export type NameKind = (typeof NAME_KINDS)[number];

/** One name token (layer 2): the kind and the name as it was written. The wire sends it through its one gate (`wireName`). */
export interface ArgName {
  kind: NameKind;
  name: string;
}

/** A word of a shell command as the tokenizer read it. */
export interface CommandWord {
  text: string;
  quoted: boolean;
  /** The variable the whole word references: set only when the word's raw source, quotes included, is exactly one reference (`variableOf`). Every other word holds none, whatever `$` it contains. */
  variable?: string;
  /** The word starts at or after the command's opaque point (`tokenize`): no variable, assignment, or flag value is read from it. */
  opaque?: true;
  /** The word's raw source starts with an unquoted `NAME=` or `--flag=` and holds a double quote after it (`tokenize`): `quoted` is true, but the name and the joined value are read as for an unquoted word. */
  joined?: true;
}

/** A shell command's words as the name read takes them: those before the program (assignments, wrappers), the program's own word, and its arguments. */
export interface CommandWords {
  before: readonly CommandWord[];
  head: CommandWord;
  args: readonly CommandWord[];
}

const DIR_ARGS = words('cwd workdir directory dir path');
const ENV_ARGS = words('env environment envs');
const VARIABLE_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const ENV_NAME = new RegExp(`^${VARIABLE_NAME}$`);
const ENV_ASSIGNMENT = new RegExp(`^(${VARIABLE_NAME})=`);
// A PowerShell scope word before the name (`$env:NAME`, `$script:NAME`, `$global:NAME`) is not part of it, in any case. Only these three: any other word before a colon (`$local:x`, `$private:x`) is an ordinary POSIX variable and its text after the colon is not a name.
const WHOLE_REFERENCE = new RegExp(`^(?:\\$(?:(?:env|script|global):)?(${VARIABLE_NAME})|\\$\\{(?:(?:env|script|global):)?(${VARIABLE_NAME})\\})$`, 'i');
/**
 * The one rule for a variable reference: a word names a variable only when its raw source, quotes included, is exactly one reference: `$NAME`, `${NAME}`, or a PowerShell `$env:NAME` or scope form (`$script:NAME`, `$global:NAME`),
 * bare or in double quotes. Every other word is literal: a `$` inside a longer word, a quote, a command substitution, an escape, and `%NAME%` (no POSIX shell or PowerShell expands it) name nothing, which sends less and never more.
 * The tokenizer reads each word through this.
 */
export const variableOf = (raw: string): string | undefined => {
  const match = WHOLE_REFERENCE.exec(/^"(.*)"$/s.exec(raw)?.[1] ?? raw);
  return match?.[1] ?? match?.[2];
};
// A path that is exactly a home folder, on any mount or distribution (`/home/jsmith`, `C:\Users\jsmith`, `/mnt/c/Users/jsmith`, `/c/Users/jsmith`, `/var/home/jsmith`, `/export/home/jsmith`, `\\wsl.localhost\Ubuntu\home\jsmith`): its last
// segment is the machine's account name, not a file. The test runs only on a path outside the session root, so the folders above `home` or `users` need no list.
const HOME_FOLDER = /(?:^|[\\/])(?:home|users)[\\/][^\\/]+[\\/]*$/i;
// A long flag with its value joined (`--region=eu`), or a flag word on its own: a long flag, or one short letter. A cluster (`-am`) or a short flag with its value attached holds no flag name of its own.
const JOINED_LONG_FLAG = /^(--[A-Za-z][A-Za-z0-9_-]*)=(.*)$/s;
const FLAG_TOKEN = /^(?:--[A-Za-z][A-Za-z0-9_-]*|-[A-Za-z])$/;
const FLAG_VALUE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// The flags whose value is text, a message or a query or an expression, and so no name even when it is one word.
const TEXT_FLAGS = words('-m --message --body --title --description --comment --text --query --data --eval -e --command --subject --notes');
// The flags whose value is a credential, so never a name however word-like it is: the redactor only knows the shapes of the credentials it has seen, and an opaque token is none of them.
const CREDENTIAL_FLAGS = words(
  '--token --access-token --accesstoken --access_token --auth-token --authtoken --auth_token --api-token --apitoken --api_token --refresh-token --bearer --bearer-token --id-token ' +
    '--password --passwd --pass --mysqlpass --pwd --passphrase --secret --client-secret --client_secret --secret-key --secret_key --secret-access-key ' +
    '--api-key --apikey --api_key --private-key --auth --authorization --credential --credentials',
);
// A prefixed spelling is a credential by its last word: set off by a separator or a capital letter (`--db-password`, `--db-pass`, `--vendor_api_key`, `--clientSecret`, `--AWSSecret`), or joined to what precedes it for the words
// that are rarely the end of anything else (`--dbpassword`, `--githubtoken`, `--clientsecret`). `pass` needs the separator, so `--bypass` and `--compass` are not credentials, and neither are `--tokenizer`, `--customer`, `--sort-key`,
// and a bare `--key`. The list is finite: a credential under a name that fits none of these shapes still reads as a name.
const CREDENTIAL_SUFFIX =
  /(?:^|[-_])(?:token|password|passwd|pass|pwd|passphrase|secret|credentials?|cookie)$|(?:password|passwd|passphrase|secret|token)$|(?:api|private|secret|access|encryption|signing|master|license|shared|session)[-_]key$/;
const isCredentialFlag = (flag: string): boolean =>
  CREDENTIAL_FLAGS.has(flag.toLowerCase()) ||
  CREDENTIAL_SUFFIX.test(
    flag
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase(),
  );

// The one-letter flags whose next word is a name, and only on the program that gives them that meaning: `-k` selects tests on pytest, and is a passphrase on `openssl` and a switch on `curl` and `du`. Any other one-letter flag may be a
// switch followed by a positional (`-i needle`) or take a credential (`-p`), so its next word is not read.
const SHORT_NAME_FLAGS = words('-k');
const PYTEST_PROGRAMS = words('pytest py.test');
const runsPytest = (head: CommandWord, args: readonly CommandWord[]): boolean =>
  PYTEST_PROGRAMS.has(head.text.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()) || args.some((word, at) => !word.quoted && word.text === '-m' && args[at + 1]?.text === 'pytest');

/**
 * The values of a command's flags that are names: the next word of a long flag (or of `-k` on pytest), or the value joined to a long one, when it is a single identifier-like word, and the flag is not one that takes
 * text or a credential. A long boolean flag followed by a positional is still read as if the positional were its value.
 */
const flagValueNames = (head: CommandWord, args: readonly CommandWord[]): string[] => {
  const pytest = runsPytest(head, args);
  const found: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    // A word after the command's opaque point (`tokenize`) may be literal text the reader took for words, so neither its joined value nor the word after it is a name.
    if (word === undefined || (word.quoted && word.joined !== true) || word.opaque === true) continue;
    if (word.text === '--') break;
    const joined = JOINED_LONG_FLAG.exec(word.text);
    const flag = joined?.[1] ?? word.text;
    if (TEXT_FLAGS.has(flag) || isCredentialFlag(flag) || !FLAG_TOKEN.test(flag)) continue;
    const after = flag.startsWith('--') || (pytest && SHORT_NAME_FLAGS.has(flag)) ? args[at + 1] : undefined;
    const next = after?.opaque === true ? undefined : after;
    const value = joined === null ? (next !== undefined && (next.quoted || !next.text.startsWith('-')) ? next.text : undefined) : joined[2];
    if (value !== undefined && FLAG_VALUE_NAME.test(value)) found.push(value);
  }
  return found;
};

const isPlainObject = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The name tokens of a call (layer 2), read from the values layer 1 reads: the file basename of each path value and the directory names of its segments below the root (else the working folder), never a segment above it, so an account
 * or home folder is not here; the variable names a shell command assigns (`VAR=` before its program), references (`$VAR`, `${VAR}`), or an `env` object holds; a flag value that is a name; and a custom agent's `subagent_type`.
 * Never a value: an assignment's value, a message, a path, and a number are read for the name and go no further. Sorted by kind, then name, and single. The wire sends each through its one gate.
 */
export const argNamesOf = (
  native: string,
  input: { readonly [key: string]: unknown },
  root: string | undefined,
  cwd: string | undefined,
  commands: readonly CommandWords[],
  closed: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
  restored: readonly string[] = [],
): ArgName[] => {
  const held = new Map<string, ArgName>();
  const add = (kind: NameKind, name: string): void => {
    if (name !== '') held.set(`${kind}\0${name}`, { kind, name });
  };
  const addPath = (value: string, folderArg: boolean): void => {
    // A value that starts with a variable (`$HOME/notes`, `%USERPROFILE%\notes`) is anchored where the variable points, not at the cwd, so it is read as outside the root.
    const parts = /^[$%]/.test(value) ? null : partsBelow(value, root, cwd);
    const inside = (parts ?? []).filter((part) => part !== '..');
    // Above the root a segment is the machine's, not the project's: only a file's own name is read from such a path, and not even that when the path is a home folder, whose name is the account's.
    if (parts === null) {
      if (!folderArg && !HOME_FOLDER.test(value)) add('file', value.replace(/^.*[\\/]/, ''));
      return;
    }
    for (const folder of folderArg ? inside : inside.slice(0, -1)) add('dir', folder);
    if (!folderArg) add('file', inside.at(-1) ?? '');
  };
  // The path a `git restore` names is read as the path an edit names is.
  for (const path of restored) addPath(path, false);
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (typeof value === 'string' && PATH_ARGS.has(lower)) addPath(value, DIR_ARGS.has(lower));
    else if (ENV_ARGS.has(lower) && isPlainObject(value)) {
      for (const name of Object.keys(value)) if (ENV_NAME.test(name)) add('env', name);
    } else if (lower === 'subagent_type' && typeof value === 'string' && closed.get(native)?.get(key)?.has(value) === false) add('agent', value);
  }
  for (const { before, head, args } of commands) {
    for (const word of before) {
      const assigned = (word.quoted && word.joined !== true) || word.opaque === true ? null : ENV_ASSIGNMENT.exec(word.text)?.[1];
      if (assigned !== undefined && assigned !== null) add('env', assigned);
    }
    for (const word of [...before, head, ...args]) if (word.variable !== undefined) add('env', word.variable);
    for (const name of flagValueNames(head, args)) add('flag', name);
  }
  return [...held.values()].sort((a, b) => NAME_KINDS.indexOf(a.kind) - NAME_KINDS.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** What a literal of a command becomes in its template: a closed list, so a template holds no argument text. `<flag>` is a flag-like word whose name is not spelled (an attached value, a cluster off the public list). */
export const TEMPLATE_SLOTS = ['<text>', '<path>', '<ident>', '<num>', '<url>', '<var>', '<flag>'] as const;
export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

// A command is redacted before it is read, so an scp-style address (`git@host:org/repo`) reaches here as the redactor's email mask and is no URL word.
const URL_WORD = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)/i;
const NUMBER_WORD = /^[+-]?\d+(?:[.,]\d+)*$/;
// A separator, a glob character, a home or dot folder, or a file extension: the word names a place, whatever it is called.
const PATH_WORD = /[\\/*?]|^~|^\.{1,2}$|\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const SHORT_FLAG_NAME = /^-[A-Za-z]$/;

/** The program as the step identity names it: the basename in lower case, without a Windows launcher suffix. */
const programName = (text: string): string =>
  text
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, '');

/** The slot a literal word has, by its shape alone, in this order: URL, number, path, identifier, then any other text. */
const slotOf = (text: string): TemplateSlot => {
  if (URL_WORD.test(text)) return '<url>';
  if (NUMBER_WORD.test(text)) return '<num>';
  if (PATH_WORD.test(text)) return '<path>';
  return FLAG_VALUE_NAME.test(text) ? '<ident>' : '<text>';
};

/**
 * A flag word as a template holds it, and whether the word after it is text. A number (`head -20`) is `<num>`. A flag keeps its name when it is on the public flag list or is one letter, the two cases the step identity names too; any other flag is `<flag>`
 * (a private script's flag, a cluster, a value attached to a short flag), so a flag a program or a person made up is not spelled. The value joined to a kept flag is its slot. The next word is text after a text or credential flag, and after any
 * one-letter flag but `-k` on pytest (`pytest`): the names reader refuses to read that word (`-p` is a password on `sshpass` and a count on `head`), so its type is not sent either.
 */
const flagToken = (text: string, redact: (text: string) => string, opaque: boolean, pytest: boolean): { token: string; text: boolean } => {
  if (NUMBER_WORD.test(text)) return { token: '<num>', text: false };
  const joined = JOINED_LONG_FLAG.exec(text);
  const flag = joined?.[1] ?? text;
  const takesText = TEXT_FLAGS.has(flag) || isCredentialFlag(flag) || (SHORT_FLAG_NAME.test(flag) && !(pytest && SHORT_NAME_FLAGS.has(flag)));
  if (!PUBLIC_FLAGS.has(flag) && !SHORT_FLAG_NAME.test(flag)) return { token: '<flag>', text: joined === null && takesText };
  if (joined !== null) return { token: `${redact(flag)}=${opaque || takesText ? '<text>' : slotOf(joined[2] ?? '')}`, text: false };
  return { token: redact(flag), text: takesText };
};

/**
 * One command as a template: its program, its subcommand, and its flags, as written, and every other word as a slot (`git commit -m <text>`, `pytest <path> -k <ident>`). A program given as a path is `<path>`. The subcommand is the first word the
 * program's own public table lists (`PUBLIC_SUBCOMMANDS`, the table the step identity reads), so no free word of an argument list is ever kept as one. The word after a credential flag, a text flag, or a one-letter flag (but `-k` on pytest), joined or apart, is
 * `<text>` whatever its shape, so not even the type of a secret is sent. A word after `--`, a quoted word, and a word at or after the command's opaque point (`tokenize`) are never kept words: a flag-shaped one at that point keeps its name and no value. A variable reference is
 * `<var>` and its name is the names layer's. Every kept word is masked by `redact`, so a credential-shaped word is not stored as it is; the wire gates each one again (`wireTemplate`).
 */
const templateOf = ({ head, args }: CommandWords, redact: (text: string) => string): string => {
  const program = programName(head.text);
  const table = PUBLIC_SUBCOMMANDS.get(program);
  const tokens: string[] = [];
  if (head.variable !== undefined) tokens.push('<var>');
  else if (head.opaque === true || (head.quoted && /\s/.test(head.text))) tokens.push('<text>');
  else tokens.push(/[\\/]|^~|^\.{1,2}$/.test(head.text) ? '<path>' : redact(program));
  const pytest = runsPytest(head, args);
  let subcommand = false;
  let textNext = false;
  let ended = false;
  for (const word of args) {
    const text = textNext;
    textNext = false;
    const flagLike = (!word.quoted || word.joined === true) && !ended && word.text.startsWith('-') && word.text !== '--';
    if (word.variable !== undefined) tokens.push('<var>');
    else if (text || (word.opaque === true && !flagLike)) tokens.push('<text>');
    else if (ended || (word.quoted && !flagLike)) tokens.push(slotOf(word.text));
    else if (word.text === '--') {
      ended = true;
      tokens.push('--');
    } else if (flagLike) {
      const flag = flagToken(word.text, redact, word.opaque === true, pytest);
      textNext = flag.text;
      tokens.push(flag.token);
    } else if (!subcommand && table?.has(word.text) === true) {
      subcommand = true;
      tokens.push(redact(word.text));
    } else tokens.push(slotOf(word.text));
  }
  return tokens.join(' ');
};

/** A call's command templates, one per command in the order they run (`templateOf`). Sent through the wire's one gate, which drops a template whose kept word fails it. */
export const templatesOf = (commands: readonly CommandWords[], redact: (text: string) => string): string[] => commands.map((command) => templateOf(command, redact));

/** What an edit did, as a closed set: the shape of the change and never its text. Written in this order on the wire. */
export const DIFF_SHAPES = ['import-added', 'import-removed', 'identifier-renamed', 'lines-added', 'lines-removed', 'lines-changed', 'whitespace-only', 'file-written'] as const;
export type DiffShape = (typeof DIFF_SHAPES)[number];

// A line that brings a module in, in the forms the common languages share: an import, a from-import, a require, an include, a using directive, and a use declaration.
const IMPORT_LINE = /^(?:import\s|from\s+\S+\s+import\s|(?:const|let|var)\s.*=\s*require\(|#include\s|using\s+(?:static\s+)?[\w.]+\s*;?$|use\s+[\w:{}, *]+;?$)/;
const CODE_TOKEN = /[A-Za-z_$][\w$]*|\d+|\s+|[^\w\s$]/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const textLines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

/** The lines of `from` that `against` does not hold, by count and in order, so a line moved is no change. */
const unmatched = (from: readonly string[], against: readonly string[]): string[] => {
  const spare = new Map<string, number>();
  for (const line of against) spare.set(line, (spare.get(line) ?? 0) + 1);
  return from.filter((line) => {
    const held = spare.get(line) ?? 0;
    spare.set(line, held - 1);
    return held <= 0;
  });
};

/** Whether `after` is `before` with names replaced: the same tokens apart from identifiers, each old name replaced by one new name and no two by the same, and no replaced name left standing in the line. */
const isRename = (before: string, after: string): boolean => {
  const was = Array.from(before.matchAll(CODE_TOKEN), (token) => token[0]);
  const now = Array.from(after.matchAll(CODE_TOKEN), (token) => token[0]);
  if (was.length !== now.length) return false;
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  for (const [at, old] of was.entries()) {
    const next = now[at] ?? '';
    if (old === next) continue;
    if (!IDENTIFIER.test(old) || !IDENTIFIER.test(next) || (forward.get(old) ?? next) !== next || (backward.get(next) ?? old) !== old) return false;
    forward.set(old, next);
    backward.set(next, old);
  }
  return forward.size > 0 && !was.some((token, at) => token === now[at] && (forward.has(token) || backward.has(token)));
};

/** The shapes of one edit, from its old and new text. Whitespace alone is one shape; else the lines that differ are read as imports, renames (a removed and an added line that pair up), changed lines, and lines only added or removed. */
const shapesOfEdit = (before: string, after: string): Set<DiffShape> => {
  const held = new Set<DiffShape>();
  if (before === after) return held;
  if (before.replace(/\s+/g, '') === after.replace(/\s+/g, '')) return held.add('whitespace-only');
  const was = textLines(before);
  const now = textLines(after);
  const removed = unmatched(was, now);
  const added = unmatched(now, was);
  for (const line of removed) if (IMPORT_LINE.test(line)) held.add('import-removed');
  for (const line of added) if (IMPORT_LINE.test(line)) held.add('import-added');
  const gone = removed.filter((line) => !IMPORT_LINE.test(line));
  const come = added.filter((line) => !IMPORT_LINE.test(line));
  // Lines that changed pair up in the order they stand, so a rename is a pair that reads as one.
  for (const [at, line] of gone.entries()) {
    const partner = come[at];
    if (partner !== undefined) held.add(isRename(line, partner) ? 'identifier-renamed' : 'lines-changed');
  }
  if (come.length > gone.length) held.add('lines-added');
  if (gone.length > come.length) held.add('lines-removed');
  return held;
};

/**
 * What a call that edits a file did, as a closed set (layer 3), never its text: a `Write` is `file-written`; an `Edit` or each entry of a `MultiEdit` is read from its old and new text (`shapesOfEdit`), and the call has the union, in the list's order.
 * A call that is no edit, or an edit that changes nothing, has none.
 */
export const diffShapeOf = (tool: string, input: { readonly [key: string]: unknown }): DiffShape[] => {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const edits = tool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : tool === 'Edit' ? [input] : [];
  const held = new Set<DiffShape>(tool === 'Write' ? ['file-written'] : []);
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null) continue;
    for (const shape of shapesOfEdit(text(Reflect.get(edit, 'old_string')), text(Reflect.get(edit, 'new_string')))) held.add(shape);
  }
  return DIFF_SHAPES.filter((shape) => held.has(shape));
};

/**
 * What changed from the previous call of the same tool in the same prompt, as a closed set (layer 1): `same` when nothing did; else any of a key added, a key removed, a kept key's value whose features or closed value
 * changed (`feature-changed`), a kept key's value that changed while its features did not (`value-changed`), and the target (`target-changed`). The first call of a tool in a prompt has none.
 */
export const CHANGE_KINDS = ['same', 'key-added', 'key-removed', 'feature-changed', 'value-changed', 'target-changed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** A call as the change read compares it: its raw input and target, held only while capture reads the transcript, with the features and closed values computed from them. */
export interface ComparedCall {
  input: { readonly [key: string]: unknown };
  target: string | null;
  features: readonly ArgFeature[];
  values: readonly ArgValue[];
}

export const changeKindOf = (before: ComparedCall, after: ComparedCall): ChangeKind[] => {
  const was = new Set(Object.keys(before.input));
  const now = new Set(Object.keys(after.input));
  const facts = (call: ComparedCall, key: string): string => JSON.stringify([call.features.find((entry) => entry.key === key) ?? null, call.values.find((entry) => entry.key === key) ?? null]);
  const kept = [...now].filter((key) => was.has(key));
  const moved = kept.filter((key) => JSON.stringify(before.input[key]) !== JSON.stringify(after.input[key]));
  const held = new Set<ChangeKind>();
  if ([...now].some((key) => !was.has(key))) held.add('key-added');
  if ([...was].some((key) => !now.has(key))) held.add('key-removed');
  if (moved.some((key) => facts(before, key) !== facts(after, key))) held.add('feature-changed');
  if (moved.some((key) => facts(before, key) === facts(after, key))) held.add('value-changed');
  if (before.target !== after.target) held.add('target-changed');
  return held.size === 0 ? ['same'] : CHANGE_KINDS.filter((kind) => held.has(kind));
};
