// A step's `identity` (recall spec Section 2.2): what the step acted on, by action. A program, subcommand, flag, MCP server and tool pass through
// `public-vocabulary.ts` and become `<literal>` when it does not list them; a skill-run name, a host, and a pull name are kept as they are after the
// operator's redaction (CAPTURE 24), and what leaves the machine is decided at the deposit's one gate and by the pool.

import { mcpOf, type ActionTable, type CanonicalAction } from './actions.js';
import { isWireName, isWirePullName, wireName } from './pool-wire.js';
import { BUNDLING_PROGRAMS, isPublicMcpTool, isRegistryVersion, LITERAL, PRIVATE, PUBLIC_FLAGS, PUBLIC_MCP_SERVERS, PUBLIC_PACKAGES, PUBLIC_PROGRAMS, PUBLIC_SUBCOMMANDS } from './public-vocabulary.js';
import type { Redactor } from './redact.js';
import type { PullEcosystem, PullIdentity, ShellIdentity, StepIdentity, ToolPull } from './schema.js';

/** A word of a shell command, as the tokenizer read it. */
export interface WordOfCommand {
  text: string;
  quoted: boolean;
  /** The variable the whole word references, set only when its raw source is exactly one reference (`$NAME`, `"${NAME}"`); a `$` anywhere else in a word is text. */
  variable?: string;
  /** The word starts at or after the command's opaque point (`tokenize`), where a misread quote can turn literal text into words: the name read takes no variable, assignment, or flag value from it. */
  opaque?: true;
  /** The word's raw source starts with an unquoted `NAME=` or `--flag=` and holds a double quote after it (`API_REGION="eu"`, `--region="eu"`): `quoted` is true, but the text up to the `=` is as written, so the name and the joined value are read as for an unquoted word. Never set on a word that holds a single quote or a substitution after the `=`, since those are where literal text begins. */
  joined?: true;
}

const orLiteral = (name: string, allowed: ReadonlySet<string>): string => (allowed.has(name) ? name : LITERAL);

/**
 * A long-tail name (a skill run, a host, a pull) as the store keeps it: the name itself, or `<literal>` when it is not a name or the operator's redaction would change it. The test is the wire's own (`wireName`), so a name stored here is a
 * name the deposit sends, and a list never decides it: the pool does, by deploy. The operator's exclusion terms are the deposit's, since they change after the capture.
 */
const keptName = (name: string, redact: Redactor, hasShape: (name: string) => boolean = isWireName): string => {
  const kept = wireName({ redact, terms: [] }, name, hasShape);
  return kept === PRIVATE ? LITERAL : kept;
};

const SHORT_CLUSTER = /^-[a-z]{1,4}$/;
const SHORT_LETTER = /^-[A-Za-z]$/;
// A short flag with a value joined after a non-letter, as in `-c1-200`: the first capture is the name and the rest is the value, which is dropped.
const JOINED_VALUE = /^(-[A-Za-z])[^A-Za-z]/;
// `head -20`: the digits are the value and the flag has no name of its own, so every such flag reads alike.
const BARE_NUMBER = /^-\d+$/;
export const NUMBER_FLAG = '-N';

/**
 * The names one flag word holds, without its value. On a program that bundles, a short cluster reads as its letters, so `-rf` and `-fr` agree;
 * a value joined to a flag there can still read as letters, one each and never the word. On any other program the cluster is the literal.
 */
const flagNames = (text: string, bundles: boolean): string[] => {
  const name = text.split('=')[0] ?? text;
  if (name.startsWith('--') || PUBLIC_FLAGS.has(name)) return [orLiteral(name, PUBLIC_FLAGS)];
  if (SHORT_LETTER.test(name)) return [name];
  if (BARE_NUMBER.test(name)) return [NUMBER_FLAG];
  const joined = JOINED_VALUE.exec(name)?.[1];
  if (joined !== undefined) return [joined];
  return bundles && SHORT_CLUSTER.test(name) ? Array.from(name.slice(1), (letter) => `-${letter}`) : [LITERAL];
};

const flagsOf = (program: string, args: readonly WordOfCommand[]): string[] => {
  const bundles = BUNDLING_PROGRAMS.has(program);
  const flags = new Set<string>();
  for (const { text, quoted } of args) {
    if (text === '--') break;
    if (quoted || !text.startsWith('-') || text.includes('$')) continue;
    for (const name of flagNames(text, bundles)) flags.add(name);
  }
  return [...flags].sort();
};

export const isPositional = ({ text, quoted }: WordOfCommand): boolean => !quoted && text !== '' && !text.startsWith('-') && !/[$\\/]/.test(text);

/** A subcommand from the program's own table, wherever a global flag's value left it; a positional word outside the table is the literal. */
const subOf = (program: string, args: readonly WordOfCommand[]): string | null => {
  const table = PUBLIC_SUBCOMMANDS.get(program);
  if (table === undefined) return null;
  const positional = args.filter(isPositional);
  const known = positional.find(({ text }) => table.has(text));
  if (known !== undefined) return known.text;
  return positional.length === 0 ? null : LITERAL;
};

const REGISTRY_OF: { readonly [ecosystem in PullEcosystem]: string } = {
  npm: 'npm',
  pypi: 'pypi',
  cargo: 'crates',
  go: 'go',
  gem: 'rubygems',
  brew: 'homebrew',
  skill: 'skill',
  plugin: 'plugin',
  mcp: 'mcp',
};

/**
 * A pull with its package name as written (the command was redacted before it was read, and the name is checked once more part by part, as a host and a skill-run name are). A package off the public list can be identified by its version, so the version is masked beside it; a stated version of a listed package stays stated.
 * A name that is not one (a URL, a path, a mask) is `<literal>`.
 */
export const pullIdentity = (pull: ToolPull, redact: Redactor): PullIdentity => {
  const name = keptName(pull.name, redact, isWirePullName);
  const showsVersion = PUBLIC_PACKAGES.has(name) && pull.version !== null && isRegistryVersion(pull.version);
  return { registry: REGISTRY_OF[pull.ecosystem], name, version: pull.version === null ? null : showsVersion ? pull.version : LITERAL };
};

/** A shell step whose program is private or unreadable: its flags are its own, so none are kept. */
export const UNREAD_SHELL: ShellIdentity = { program: LITERAL, sub: null, flags: [] };

/** Flags of `git checkout` that take only paths: a checkout with one of them acts on a path, never on a branch. */
const PATH_ONLY_FLAGS: ReadonlySet<string> = new Set(['--ours', '--theirs', '--patch', '-p', '--pathspec-from-file']);

/**
 * The class of what a `git checkout` acts on, from the line alone and never the target's text. A `--` marker or a path-only flag proves a path; a target word the segment drops (the same
 * words `isPositional` refuses: quoted, or holding a slash, a backslash, or `$`) with neither proof could be a branch (`feature/x`) or a path (`src/a.ts`), so it is `word`; no such word is absent.
 */
const checkoutTarget = (all: readonly WordOfCommand[]): ShellIdentity['target'] => {
  // Words before `checkout` are the global options of `git` (`-C <dir>`), not what the checkout acts on.
  const args = all.slice(all.findIndex(({ text, quoted }) => !quoted && text === 'checkout') + 1);
  const dashes = args.findIndex(({ text, quoted }) => !quoted && text === '--');
  const flagWords = (dashes < 0 ? args : args.slice(0, dashes)).filter(({ text, quoted }) => !quoted && text.startsWith('-')).map(({ text }) => text.split('=')[0] ?? text);
  if (dashes >= 0 || flagWords.some((flag) => PATH_ONLY_FLAGS.has(flag))) return 'path';
  return args.some((word) => (word.quoted || !word.text.startsWith('-')) && !isPositional(word)) ? 'word' : undefined;
};

export const shellIdentity = (program: string, args: readonly WordOfCommand[], pulls: readonly ToolPull[], redact: Redactor): ShellIdentity => {
  if (!PUBLIC_PROGRAMS.has(program)) return UNREAD_SHELL;
  const sub = subOf(program, args);
  const target = program === 'git' && sub === 'checkout' ? checkoutTarget(args) : undefined;
  const identity: ShellIdentity = { program, sub, flags: flagsOf(program, args), ...(target === undefined ? {} : { target }) };
  return pulls.length === 0 ? identity : { ...identity, pulls: pulls.map((pull) => pullIdentity(pull, redact)) };
};

const hostOf = (url: string | undefined, redact: Redactor): { host: string | null } => {
  if (url === undefined || url === '') return { host: null };
  // The parser drops credentials, the path, and the query, and lower-cases the host; the redactor and the name shape then decide, and the pool hashes it on arrival.
  const parsed = URL.canParse(url) ? new URL(url).hostname : '';
  return { host: keptName(parsed, redact) };
};

/** What a non-shell call's step reads as. `native` comes back masked unless every name it holds is public, since an MCP name spells out its server. */
export const callIdentity = (table: ActionTable, action: CanonicalAction, native: string, shown: string, input: { skill: string | undefined; url: string | undefined; redact: Redactor }): { native: string; identity: StepIdentity } => {
  if (action === 'web.fetch' || action === 'web.search') return { native: shown, identity: hostOf(input.url, input.redact) };
  if (action === 'skill.run') return { native: shown, identity: { skill: keptName(input.skill ?? '', input.redact) } };
  const mcp = action === 'mcp.call' ? mcpOf(table, native) : undefined;
  if (mcp === undefined) return { native: shown, identity: null };
  if (!PUBLIC_MCP_SERVERS.has(mcp.server)) return { native: LITERAL, identity: { server: LITERAL, tool: LITERAL } };
  if (!table.toolDelimited || !isPublicMcpTool(mcp.server, mcp.tool)) return { native: LITERAL, identity: { server: mcp.server, tool: LITERAL } };
  return { native, identity: { server: mcp.server, tool: mcp.tool } };
};
