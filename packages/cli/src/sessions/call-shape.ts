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
 * so a lockfile is never `config` and a `tests/data.json` is `test`. The mapping is pinned in `call-shape.test.ts`. The path is read here and goes no further.
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
