// A step's `identity` (t755, recall spec Section 2.2): what the step acted on, by action, in public names only. Every name passes through
// `public-vocabulary.ts`, so what may leave the machine is decided in that one file; anything it does not list becomes `<literal>`.

import { mcpOf, type ActionTable, type CanonicalAction } from './actions.js';
import { isMcpToolName, isRegistryVersion, LITERAL, PUBLIC_FLAGS, PUBLIC_HOSTS, PUBLIC_MCP_SERVERS, PUBLIC_PACKAGES, PUBLIC_PROGRAMS, PUBLIC_SKILLS, PUBLIC_SUBCOMMANDS } from './public-vocabulary.js';
import type { PullEcosystem, PullIdentity, ShellIdentity, StepIdentity, ToolPull } from './schema.js';

/** A word of a shell command, as the tokenizer read it. */
export interface WordOfCommand {
  text: string;
  quoted: boolean;
}

const orLiteral = (name: string, allowed: ReadonlySet<string>): string => (allowed.has(name) ? name : LITERAL);

const SHORT_CLUSTER = /^-[a-z]{1,4}$/;
const SHORT_LETTER = /^-[A-Za-z]$/;

/** The names one flag word holds, without its value. A short cluster reads as its letters, so `-rf` and `-fr` agree and a value joined to a letter stays out. */
const flagNames = (text: string): string[] => {
  const name = text.split('=')[0] ?? text;
  if (name.startsWith('--') || PUBLIC_FLAGS.has(name)) return [orLiteral(name, PUBLIC_FLAGS)];
  if (SHORT_LETTER.test(name)) return [name];
  return SHORT_CLUSTER.test(name) ? Array.from(name.slice(1), (letter) => `-${letter}`) : [LITERAL];
};

const flagsOf = (args: readonly WordOfCommand[]): string[] => {
  const flags = new Set<string>();
  for (const { text, quoted } of args) {
    if (text === '--') break;
    if (quoted || !text.startsWith('-') || text.includes('$')) continue;
    for (const name of flagNames(text)) flags.add(name);
  }
  return [...flags].sort();
};

const isPositional = ({ text, quoted }: WordOfCommand): boolean => !quoted && text !== '' && !text.startsWith('-') && !/[$\\/]/.test(text);

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

/** A pull in public names. A private package's version can still identify it, so it is masked with the name; a stated version stays stated. */
export const pullIdentity = (pull: ToolPull): PullIdentity => {
  const name = orLiteral(pull.name, PUBLIC_PACKAGES);
  const showsVersion = name !== LITERAL && pull.version !== null && isRegistryVersion(pull.version);
  return { registry: REGISTRY_OF[pull.ecosystem], name, version: pull.version === null ? null : showsVersion ? pull.version : LITERAL };
};

/** A shell step whose program is private or unreadable: its flags are its own, so none are kept. */
export const UNREAD_SHELL: ShellIdentity = { program: LITERAL, sub: null, flags: [] };

export const shellIdentity = (program: string, args: readonly WordOfCommand[], pulls: readonly ToolPull[]): ShellIdentity => {
  if (!PUBLIC_PROGRAMS.has(program)) return UNREAD_SHELL;
  const identity: ShellIdentity = { program, sub: subOf(program, args), flags: flagsOf(args) };
  return pulls.length === 0 ? identity : { ...identity, pulls: pulls.map(pullIdentity) };
};

const hostOf = (url: string | undefined): { host: string | null } => {
  if (url === undefined || url === '') return { host: null };
  // The parser drops credentials, the path, and the query, and lower-cases the host; the list then decides.
  const parsed = URL.canParse(url) ? new URL(url).hostname : '';
  return { host: orLiteral(parsed, PUBLIC_HOSTS) };
};

/** What a non-shell call's step reads as. `native` comes back masked unless every name it holds is public, since an MCP name spells out its server. */
export const callIdentity = (table: ActionTable, action: CanonicalAction, native: string, shown: string, input: { skill: string | undefined; url: string | undefined }): { native: string; identity: StepIdentity } => {
  if (action === 'web.fetch' || action === 'web.search') return { native: shown, identity: hostOf(input.url) };
  if (action === 'skill.run') return { native: shown, identity: { skill: orLiteral(input.skill ?? '', PUBLIC_SKILLS) } };
  const mcp = action === 'mcp.call' ? mcpOf(table, native) : undefined;
  if (mcp === undefined) return { native: shown, identity: null };
  if (!PUBLIC_MCP_SERVERS.has(mcp.server)) return { native: LITERAL, identity: { server: LITERAL, tool: LITERAL } };
  const tool = isMcpToolName(mcp.tool) ? mcp.tool : LITERAL;
  return { native: tool === LITERAL ? LITERAL : native, identity: { server: mcp.server, tool } };
};
