// What a call touched, in shape and never in value (t870): the class of its target and the classes of its arguments. Both are computed at capture, from
// the path and the input that only the extractor holds, and stored as closed-list members. The path, the argument values, and the base name never leave it.
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
const DRIVE = /^[a-z]:$/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/]|~)/i;

const sizeOf = (value: unknown): ValueSize => {
  const length = (typeof value === 'string' ? value : JSON.stringify(value)).length;
  return VALUE_SIZES[SIZE_EDGES.filter((edge) => length >= edge).length] ?? 'over-8k';
};

const depthOf = (folders: number): PathDepth => (folders <= 2 ? PATH_DEPTHS[folders] ?? '0' : folders <= 4 ? '3-4' : folders <= 8 ? '5-8' : 'over-8');

/** A path with its `.` and `..` parts resolved, so a path that climbs out of a folder reads as outside it. A Windows drive stays, as the leading `/` of a posix path does. */
const resolved = (path: string): string => {
  const kept: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (kept.length !== 1 || !DRIVE.test(kept[0] ?? '')) kept.pop();
    } else if (part !== '' && part !== '.') kept.push(part);
  }
  return `${path.startsWith('/') ? '/' : ''}${kept.join('/')}`;
};

/**
 * A path value's folders and name below the base folder, or null for an absolute path outside it. A relative value is taken from the cwd before it is measured, so a relative and an absolute path to one file read the same
 * when the cwd is a folder inside the repository. Only the counts and classes below leave this function.
 */
const partsBelow = (value: string, root: string | undefined, cwd: string | undefined): string[] | null => {
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  const given = value.replace(/\\/g, '/');
  const from = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = ABSOLUTE.test(given) || from === undefined || from === '' ? given : resolved(`${from}/${given}`);
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
