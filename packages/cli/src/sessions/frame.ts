// The frame (t755, recall spec Section 2.1): where and when a prompt ran, as public names only, and its hash. A step takes its prompt's frame,
// and reading one motif across frames is how the record compares models, harnesses, versions, and dates.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FRAMEWORK_OF_FILE, FRAMEWORK_OF_PROGRAM, FRAMEWORKS, LANGUAGE_OF_EXTENSION, LANGUAGES, publicEffort, publicModel, publicVersion, REPO_SIZES, type RepoSize } from './public-vocabulary.js';
import type { Frame, FrameStack } from './schema.js';

/** The language mix keeps this many languages, so a frame stays a coordinate and not a fingerprint of one repository. */
const LANGUAGES_PER_STACK = 3;

/** The UTC day of a timestamp, whatever offset it was written in; null when there is none or it does not parse. */
export const utcDay = (ts: string | null | undefined): string | null => {
  if (ts === null || ts === undefined || ts === '') return null;
  const millis = Date.parse(ts);
  return Number.isNaN(millis) ? null : new Date(millis).toISOString().slice(0, 10);
};

/** A stack holding only closed-vocabulary values, sorted; anything else is dropped, not masked, because the stack has no room for an unknown. */
export const closedStack = (raw: { languages: readonly string[]; frameworks: readonly string[]; size: string | null }): FrameStack => ({
  languages: [...new Set(raw.languages)].filter((language) => LANGUAGES.has(language)).sort(),
  frameworks: [...new Set(raw.frameworks)].filter((framework) => FRAMEWORKS.has(framework)).sort(),
  size: REPO_SIZES.find((size) => size === raw.size) ?? null,
});

/** The bucket of a repository's tracked-file count; null when the count is not known. */
export const repoSizeOf = (files: number | null): RepoSize | null => {
  if (files === null) return null;
  if (files < 100) return 'xs';
  if (files < 1000) return 's';
  if (files < 10000) return 'm';
  return files < 100000 ? 'l' : 'xl';
};

const baseName = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? path;

/** The stack a file's evidence shows. Only names from the vocabulary come out, so a path or a program name can never pass through. */
export const stackOf = (evidence: { paths: readonly string[]; programs: readonly string[]; size: RepoSize | null }): FrameStack => {
  const counts = new Map<string, number>();
  const frameworks: string[] = [];
  for (const path of evidence.paths) {
    const base = baseName(path);
    const language = LANGUAGE_OF_EXTENSION.get(base.split('.').pop()?.toLowerCase() ?? '');
    if (base.includes('.') && language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1);
    for (const [pattern, name] of FRAMEWORK_OF_FILE) if (pattern.test(base)) frameworks.push(name);
  }
  for (const program of evidence.programs) {
    const name = FRAMEWORK_OF_PROGRAM.get(program);
    if (name !== undefined) frameworks.push(name);
  }
  // Most touched first, a tie by name, so the mix does not depend on the order the files were touched in.
  const languages = [...counts].sort(([a, one], [b, two]) => two - one || a.localeCompare(b)).slice(0, LANGUAGES_PER_STACK).map(([language]) => language);
  return closedStack({ languages, frameworks, size: evidence.size });
};

/** The frame with every free-standing name held to the public vocabulary. */
export const closedFrame = (raw: Frame): Frame => ({
  ...raw,
  harnessVersion: publicVersion(raw.harnessVersion),
  model: publicModel(raw.model),
  effort: publicEffort(raw.effort),
});

/** The frame's hash: unsalted, so one frame reads alike across accounts (D1's `hP`), 16 hex characters, over the fields in a fixed order. */
export const frameIdOf = (frame: Frame): string => {
  const { harness, harnessVersion, model, effort, day, platform, shell, stack } = frame;
  const canonical = JSON.stringify([harness, harnessVersion, model, effort, day, platform, shell, stack.languages, stack.frameworks, stack.size]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
};

const INDEX_HEADER_BYTES = 12;

/** Where a checkout's git index is. In a linked worktree or a submodule `.git` is a file whose `gitdir:` line names the real git folder, absolute or relative to the checkout. */
const indexPathOf = (root: string): string => {
  const dotGit = join(root, '.git');
  if (statSync(dotGit).isDirectory()) return join(dotGit, 'index');
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
  return pointer === undefined ? join(dotGit, 'index') : join(resolve(root, pointer), 'index');
};

/** How many files a repository tracks, from its git index's header: no git process, and null when there is no readable index. */
export const repoFilesFromIndex = (root: string): number | null => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(indexPathOf(root), 'r');
    const header = Buffer.alloc(INDEX_HEADER_BYTES);
    const read = readSync(descriptor, header, 0, INDEX_HEADER_BYTES, 0);
    return read === INDEX_HEADER_BYTES && header.toString('latin1', 0, 4) === 'DIRC' ? header.readUInt32BE(8) : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
