// The public vocabulary (t755, recall spec Sections 2.1, 2.2, and 7): the one file that says which names may stand in a class P field of a
// captured step or frame. Anything else becomes `<literal>`, so a private script, host, package, or server name never reaches a pooled field.
//
// A simple list on purpose, and it fails closed: a missing public name costs a `<literal>`, while a wrongly listed one costs a leak. The D11 and
// D13 vocabulary spec owns the final list and wins on what may leave the machine. This repository is public, so nothing private is ever added here.

/** What every name outside this file becomes. */
export const LITERAL = '<literal>';

export const REPO_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type RepoSize = (typeof REPO_SIZES)[number];

/** File extension to language: the stack's language mix. */
export const LANGUAGE_OF_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['py', 'python'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['cs', 'csharp'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['hpp', 'cpp'],
  ['swift', 'swift'],
  ['scala', 'scala'],
  ['sh', 'shell'],
  ['ps1', 'powershell'],
  ['sql', 'sql'],
  ['astro', 'astro'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['css', 'css'],
  ['html', 'html'],
]);
export const LANGUAGES: ReadonlySet<string> = new Set(LANGUAGE_OF_EXTENSION.values());

/** A touched file's base name to the framework it shows. */
export const FRAMEWORK_OF_FILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^pom\.xml$/, 'maven'],
  [/^build\.gradle(\.kts)?$/, 'gradle'],
  [/^vite\.config\.[a-z]+$/, 'vite'],
  [/^vitest\.config\.[a-z]+$/, 'vitest'],
  [/^astro\.config\.[a-z]+$/, 'astro'],
  [/^next\.config\.[a-z]+$/, 'next'],
  [/^nuxt\.config\.[a-z]+$/, 'nuxt'],
  [/^svelte\.config\.[a-z]+$/, 'svelte'],
  [/^angular\.json$/, 'angular'],
  [/^tailwind\.config\.[a-z]+$/, 'tailwind'],
  [/^playwright\.config\.[a-z]+$/, 'playwright'],
  [/^jest\.config\.[a-z]+$/, 'jest'],
  [/^wrangler\.(toml|jsonc?)$/, 'cloudflare-workers'],
  [/^Cargo\.toml$/, 'cargo'],
  [/^go\.mod$/, 'go-modules'],
  [/^Dockerfile$/, 'docker'],
  [/^manage\.py$/, 'django'],
  [/^Gemfile$/, 'bundler'],
  [/\.tf$/, 'terraform'],
  [/\.csproj$/, 'dotnet'],
];

/** A program a shell call ran to the framework it shows. */
export const FRAMEWORK_OF_PROGRAM: ReadonlyMap<string, string> = new Map([
  ['mvn', 'maven'],
  ['mvnw', 'maven'],
  ['gradle', 'gradle'],
  ['gradlew', 'gradle'],
  ['vite', 'vite'],
  ['vitest', 'vitest'],
  ['astro', 'astro'],
  ['playwright', 'playwright'],
  ['jest', 'jest'],
  ['wrangler', 'cloudflare-workers'],
  ['cargo', 'cargo'],
  ['docker', 'docker'],
  ['kubectl', 'kubernetes'],
  ['helm', 'kubernetes'],
  ['terraform', 'terraform'],
  ['dotnet', 'dotnet'],
  ['rails', 'rails'],
]);
export const FRAMEWORKS: ReadonlySet<string> = new Set([...FRAMEWORK_OF_FILE.map(([, name]) => name), ...FRAMEWORK_OF_PROGRAM.values()]);

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const MODEL = /^(?:(?:claude|gpt|o[134]|gemini|codex|composer|cursor|grok|deepseek|llama|mistral|qwen|kimi|glm)(?:[-.:_][a-z0-9.:_-]*)?|auto|default)$/;
const VERSION = /^\d+(?:\.\d+){0,3}(?:[-+.][0-9A-Za-z]+)*$/;
/** A name this long is not one of these: it is text someone pasted. */
const NAME_MAX = 64;

const orLiteral = (value: string | null, isPublic: (value: string) => boolean): string | null => (value === null || (value.length <= NAME_MAX && isPublic(value)) ? value : LITERAL);

export const publicEffort = (value: string | null): string | null => orLiteral(value, (effort) => EFFORTS.has(effort));
export const publicModel = (value: string | null): string | null => orLiteral(value, (model) => MODEL.test(model));
export const publicVersion = (value: string | null): string | null => orLiteral(value, (version) => VERSION.test(version));
