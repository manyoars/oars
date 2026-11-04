// The D11 projection (pool vocabulary spec Sections 1.3 and 2, t811): which names in a P field may pool as themselves. A pure function of the pinned
// `Vocabulary` and the value, computed at deposit and never written to a file. Every value that leaves here is either a member of a pinned list
// or the word `private`: the output is built from list members, never from the input text, so a private name cannot be copied through by a
// parsing mistake. A form the parser cannot read projects to `private`.

import { SHELL, shellCommands } from './extract.js';
import { isPositional, type WordOfCommand } from './identity.js';
import {
  BUNDLING_PROGRAMS,
  HARNESS_AGENT_TYPES,
  HARNESS_TOOLS,
  isPublicMcpTool,
  PIPE_MAX,
  PRIVATE,
  PUBLIC_FLAGS,
  PUBLIC_MCP_SERVERS,
  PUBLIC_PROGRAMS,
  PUBLIC_SKILLS,
  PUBLIC_SUBCOMMANDS,
  TOOL_INPUT_KEYS,
} from './public-vocabulary.js';
import type { Redactor } from './redact.js';
import type { ToolObservation } from './schema.js';
import type { Vocabulary } from './vocab-load.js';

/** One program of a shell call, as `index` carries it. */
export interface ProjectedProgram {
  program: string;
  subcommand: string | null;
  flags: string[];
}

/** A shell call: its commands in order, and the ordered `program` list a compound command pools as, capped at `pipe_max`. */
export interface ProjectedShell {
  commands: ProjectedProgram[];
  programs: string[];
}

/** What `agentType` pools as when the agent is not a built-in. */
export const CUSTOM = 'custom';

export const PRIVATE_PROGRAM: ProjectedProgram = { program: PRIVATE, subcommand: null, flags: [] };

const subcommandsOf = (vocab: Vocabulary, program: string): ReadonlySet<string> => {
  const own = vocab.programs.get(program)?.subs;
  const curated = PUBLIC_SUBCOMMANDS.get(program);
  return new Set([...(own ?? []), ...(curated ?? [])]);
};

/** A program with a page in the snapshot lists its own flags; one the snapshot lacks (a shell keyword, say) falls back to the curated list. */
const flagsOf = (vocab: Vocabulary, program: string): ReadonlySet<string> => vocab.programs.get(program)?.flags ?? PUBLIC_FLAGS;

const flagWords = (program: string, args: readonly WordOfCommand[]): string[] => {
  const names: string[] = [];
  for (const { text, quoted } of args) {
    if (text === '--') break;
    if (quoted || !text.startsWith('-') || text.includes('$')) continue;
    // The value of `--flag=value` is never read: only the part before `=` is a candidate.
    const name = text.split('=')[0] ?? text;
    names.push(name);
    if (BUNDLING_PROGRAMS.has(program) && /^-[A-Za-z]{2,}$/.test(name)) names.push(...Array.from(name.slice(1), (letter) => `-${letter}`));
  }
  return names;
};

export const isAdmittedProgram = (vocab: Vocabulary, program: string): boolean => vocab.programs.has(program) || PUBLIC_PROGRAMS.has(program);

/** One simple command to `program`, `subcommand`, and `flags`. An unlisted subcommand or flag is dropped and not counted: its program already pools. */
export const projectProgram = (vocab: Vocabulary, program: string, args: readonly WordOfCommand[]): ProjectedProgram => {
  if (!isAdmittedProgram(vocab, program)) return PRIVATE_PROGRAM;
  const subs = subcommandsOf(vocab, program);
  const subcommand = args.filter(isPositional).find(({ text }) => subs.has(text))?.text ?? null;
  const listed = flagsOf(vocab, program);
  const flags = [...new Set(flagWords(program, args).filter((name) => listed.has(name)))].sort();
  return { program, subcommand, flags };
};

/**
 * A shell call to its projection. Quoting, env prefixes, `sudo`-style wrappers, pipes, `&&` chains, and `bash -c` are read by the capture parser;
 * a command it cannot read (no program found in a non-empty text) is one `private` program, never its text.
 */
export const projectShell = (vocab: Vocabulary, command: string, redact: Redactor): ProjectedShell => {
  const read = shellCommands(command, redact);
  const commands = read.length === 0 ? [PRIVATE_PROGRAM] : read.map(({ program, args }) => projectProgram(vocab, program, args));
  return { commands, programs: commands.slice(0, PIPE_MAX).map(({ program }) => program) };
};

/** `shellTarget` cuts a subcommand at this many characters (extract.ts), so a stored subcommand this long may be a prefix of a longer private word. */
const STORED_SUBCOMMAND_CUT = 30;

/**
 * The shell call of a stored tool record, from what the account store holds (migration, spec Section 2): the program and subcommand from the class A
 * `target` text, the flags from the record's first step when that step is the same program. A record captured before CAPTURE 9 has no steps, so its
 * flags are lost (Q5): it projects the program and subcommand alone. A target that cannot be read back, cut at the subcommand limit or masked by
 * redaction, projects `private`, as does a hashed path target or a record that is not a shell call.
 */
export const projectStoredShell = (vocab: Vocabulary, tool: Pick<ToolObservation, 'tool' | 'target' | 'steps'>): ProjectedProgram => {
  if (!SHELL.has(tool.tool) || tool.target === null || tool.target === '' || tool.target.includes('<')) return PRIVATE_PROGRAM;
  const [program = '', sub, ...extra] = tool.target.split(' ');
  if (extra.length > 0 || (sub?.length ?? 0) >= STORED_SUBCOMMAND_CUT) return PRIVATE_PROGRAM;
  const words: WordOfCommand[] = sub === undefined ? [] : [{ text: sub, quoted: false }];
  const projected = projectProgram(vocab, program, words);
  const identity = tool.steps?.[0]?.identity;
  const stored = identity !== null && identity !== undefined && 'flags' in identity && identity.program === program ? identity.flags : [];
  const listed = flagsOf(vocab, program);
  return projected.program === PRIVATE ? projected : { ...projected, flags: [...new Set(stored.filter((name) => listed.has(name)))].sort() };
};

const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/** A `tool` name: an admitted built-in, `mcp:<server>:<tool>` admitted on both parts, `mcp:private`, or `private`. */
export const projectTool = (tool: string): string => {
  const mcp = MCP_TOOL.exec(tool);
  if (mcp !== null) {
    const [, server = '', name = ''] = mcp;
    return PUBLIC_MCP_SERVERS.has(server) && isPublicMcpTool(server, name) ? `mcp:${server}:${name}` : 'mcp:private';
  }
  return [...HARNESS_TOOLS.values()].some((tools) => tools.has(tool)) ? tool : PRIVATE;
};

/** A field whose non-admitted members pool only as a count (spec Section 1.3): `privateCount` is exact here, and Section 1.2 buckets it at deposit. */
export interface ProjectedNames {
  names: string[];
  privateCount: number;
}

const admit = (names: readonly string[], admitted: (name: string) => boolean): ProjectedNames => {
  const unique = [...new Set(names)];
  const kept = unique.filter(admitted);
  return { names: kept.sort(), privateCount: unique.length - kept.length };
};

/** `skills`: the published skills among the names, the rest only counted. */
export const projectSkills = (skills: readonly string[]): ProjectedNames => admit(skills, (name) => PUBLIC_SKILLS.has(name));

/** `agentType`: a built-in subagent type of a harness, else `custom`; null stays null (a main transcript). */
export const projectAgentType = (agentType: string | null): string | null =>
  agentType === null ? null : [...HARNESS_AGENT_TYPES.values()].some((types) => types.has(agentType)) ? agentType : CUSTOM;

/** `keys` of a call to `tool`: only names its published input schema lists, the rest only counted. An MCP tool lists none. */
export const projectKeys = (tool: string, keys: readonly string[]): ProjectedNames => {
  const listed = TOOL_INPUT_KEYS.get(tool);
  return admit(keys, (name) => listed?.has(name) === true);
};

/** The registry's own normalization (spec Section 1.3): npm lowercases, PyPI folds `-`, `_`, and `.`, crates.io folds `-` and `_`. */
const NORMALIZE: { readonly [ecosystem: string]: (name: string) => string } = {
  npm: (name) => name.toLowerCase(),
  pypi: (name) => name.toLowerCase().replace(/[-_.]+/g, '-'),
  crates: (name) => name.toLowerCase().replace(/_/g, '-'),
  rubygems: (name) => name,
  homebrew: (name) => name.toLowerCase(),
};

export interface ProjectedPackage {
  /** `<ecosystem>:<name>` for a seeded name, else `private`. */
  package: string;
  /** Null when no version was stated or the package is private; `private` for a version the snapshot does not list. */
  packageVersion: string | null;
}

/**
 * A package is admitted only when it is in its ecosystem's `seed_top` (before the admitted-list service exists, nothing else is admitted): a name
 * that merely resolves, further down the registry, projects to `private`. A version is admitted only when the snapshot lists it for that name.
 */
export const projectPackage = (vocab: Vocabulary, ecosystem: string, name: string, version: string | null): ProjectedPackage => {
  const normalize = NORMALIZE[ecosystem];
  const versions = normalize === undefined ? undefined : vocab.packages.get(ecosystem)?.seed.get(normalize(name));
  if (normalize === undefined || versions === undefined) return { package: PRIVATE, packageVersion: null };
  return { package: `${ecosystem}:${normalize(name)}`, packageVersion: version === null ? null : versions.has(version) ? version : PRIVATE };
};

/** A model id, lowercased the way the snapshot stores it. */
export const projectModel = (vocab: Vocabulary, model: string): string => (vocab.models.has(model.toLowerCase()) ? model.toLowerCase() : PRIVATE);

/** A harness release up to the snapshot; one published after it pools as `private` until the next VOCAB_VERSION (spec R3). */
export const projectHarnessVersion = (vocab: Vocabulary, harness: string, version: string): string => (vocab.harnessVersions.get(harness)?.has(version) === true ? version : PRIVATE);
