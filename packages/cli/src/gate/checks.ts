// The checks of `oars gate`: from one tool call, name the crossing. Pure and synchronous, with no file, clock, or network, so `replay` and
// the later hook call this same function and cannot disagree on what crossed. It reads the commands capture reads (`shellCommands`) and
// keeps its own table, because capture's `pulls` say a name was stated and the gate has to say how: installed, or fetched and run.
import type { Redactor } from '../sessions/redact.js';
import { CHANGES_FOLDER, shellCommands, type ShellCommand } from '../sessions/extract.js';
import type { Program } from './record.js';

export const CROSSING_CLASSES = ['npm-package', 'python-package', 'mcp-server', 'skill'] as const;
export type CrossingClass = (typeof CROSSING_CLASSES)[number];

export const CROSSING_FORMS = ['install', 'url-install', 'fetch-and-run', 'url-fetch-and-run', 'mcp-call', 'skill-call'] as const;
export type CrossingForm = (typeof CROSSING_FORMS)[number];

/** A command that looks like a crossing and states no name to record. Counted, so a report can say what it could not read. */
export const UNREAD_SHAPES = ['manifest-install', 'local-path', 'variable-name', 'masked-name', 'pipe-to-shell', 'behind-xargs', 'harness-registration', 'unreadable-name'] as const;
export type UnreadShape = (typeof UNREAD_SHAPES)[number];

export type VersionForm = 'pinned' | 'range' | 'tag' | 'url' | 'unstated';

export interface Crossing {
  class: CrossingClass;
  form: CrossingForm;
  /** The name as stated, redacted, normalized only where the package manager itself treats the spellings as one. */
  name: string;
  version: string | null;
  versionForm: VersionForm;
  /** The program that crossed (`npm`, `uvx`), or `mcp` and `skill` for those tools. */
  program: Program;
  /** Whether the call's own status reports this command: false behind a pipe or a later `;`. */
  statusReports: boolean;
  /**
   * Whether a registry question for this name would reach the registry the command itself would: false when the command, its environment,
   * or an earlier `cd` of the call chose the registry, the config, or the folder. A replay then leaves the name unasked.
   */
  registryAsked: boolean;
}

export interface Removal {
  class: CrossingClass;
  name: string;
}

export interface CallCheck {
  crossings: Crossing[];
  unread: UnreadShape[];
  removals: Removal[];
}

export interface ToolCall {
  tool: string;
  input: unknown;
}

type Family = 'npm-package' | 'python-package';
type Action = 'install' | 'run' | 'create' | 'remove' | 'manifest';

/** A verb path and what it does. The longest path that starts the positional words wins, so `uv pip install` beats `uv`. */
type Verbs = ReadonlyArray<readonly [readonly string[], Action]>;

const NPM_VERBS: Verbs = [
  [['install'], 'install'], [['i'], 'install'], [['in'], 'install'], [['ins'], 'install'], [['add'], 'install'],
  [['ci'], 'manifest'], [['clean-install'], 'manifest'],
  [['exec'], 'run'], [['x'], 'run'],
  [['init'], 'create'], [['create'], 'create'],
  [['uninstall'], 'remove'], [['un'], 'remove'], [['remove'], 'remove'], [['rm'], 'remove'], [['r'], 'remove'],
];
const PNPM_VERBS: Verbs = [
  [['install'], 'install'], [['i'], 'install'], [['add'], 'install'],
  [['dlx'], 'run'], [['create'], 'create'],
  [['remove'], 'remove'], [['rm'], 'remove'], [['uninstall'], 'remove'], [['un'], 'remove'],
];
const YARN_VERBS: Verbs = [
  [['install'], 'install'], [['add'], 'install'], [['global', 'add'], 'install'],
  [['dlx'], 'run'], [['create'], 'create'],
  [['remove'], 'remove'], [['global', 'remove'], 'remove'],
];
const BUN_VERBS: Verbs = [
  [['install'], 'install'], [['i'], 'install'], [['add'], 'install'], [['a'], 'install'],
  [['x'], 'run'], [['create'], 'create'],
  [['remove'], 'remove'], [['rm'], 'remove'], [['uninstall'], 'remove'],
];
const PIP_VERBS: Verbs = [[['install'], 'install'], [['uninstall'], 'remove']];
const UV_VERBS: Verbs = [
  [['add'], 'install'], [['pip', 'install'], 'install'], [['tool', 'install'], 'install'],
  [['tool', 'run'], 'run'],
  [['sync'], 'manifest'], [['pip', 'sync'], 'manifest'],
  [['remove'], 'remove'], [['pip', 'uninstall'], 'remove'], [['tool', 'uninstall'], 'remove'],
];
const PIPX_VERBS: Verbs = [[['install'], 'install'], [['inject'], 'install'], [['run'], 'run'], [['uninstall'], 'remove']];
const PROJECT_VERBS: Verbs = [[['add'], 'install'], [['install'], 'manifest'], [['sync'], 'manifest'], [['remove'], 'remove']];
const PIPENV_VERBS: Verbs = [[['install'], 'install'], [['sync'], 'manifest'], [['uninstall'], 'remove']];
const CONDA_VERBS: Verbs = [[['install'], 'install'], [['remove'], 'remove'], [['uninstall'], 'remove']];
/** The runners take the name straight after the program. */
const RUNNER_VERBS: Verbs = [[[], 'run']];

interface Tool {
  family: Family;
  verbs: Verbs;
}

/** The programs read as package tools: the closed list less the `python -m` forms (`pip`, `pipx`, and `uv` run as modules) and the two tools. */
type ToolProgram = Exclude<Program, 'python -m pip' | 'python -m pipx' | 'python -m uv' | 'mcp' | 'skill'>;
/** A command whose program is one of those, so a crossing built from it names a listed program. */
type ToolCommand = ShellCommand & { program: ToolProgram };

const TOOLS: ReadonlyMap<ToolProgram, Tool> = new Map<ToolProgram, Tool>([
  ['npm', { family: 'npm-package', verbs: NPM_VERBS }],
  ['pnpm', { family: 'npm-package', verbs: PNPM_VERBS }],
  ['yarn', { family: 'npm-package', verbs: YARN_VERBS }],
  ['bun', { family: 'npm-package', verbs: BUN_VERBS }],
  ['npx', { family: 'npm-package', verbs: RUNNER_VERBS }],
  ['pnpx', { family: 'npm-package', verbs: RUNNER_VERBS }],
  ['bunx', { family: 'npm-package', verbs: RUNNER_VERBS }],
  ['pip', { family: 'python-package', verbs: PIP_VERBS }],
  ['uv', { family: 'python-package', verbs: UV_VERBS }],
  ['uvx', { family: 'python-package', verbs: RUNNER_VERBS }],
  ['pipx', { family: 'python-package', verbs: PIPX_VERBS }],
  ['poetry', { family: 'python-package', verbs: PROJECT_VERBS }],
  ['pdm', { family: 'python-package', verbs: PROJECT_VERBS }],
  ['rye', { family: 'python-package', verbs: PROJECT_VERBS }],
  ['pipenv', { family: 'python-package', verbs: PIPENV_VERBS }],
  ['conda', { family: 'python-package', verbs: CONDA_VERBS }],
  ['mamba', { family: 'python-package', verbs: CONDA_VERBS }],
  ['micromamba', { family: 'python-package', verbs: CONDA_VERBS }],
]);

/** A flag here owns the next word, which is therefore not a package name. */
const VALUE_FLAGS: Readonly<Record<Family, ReadonlySet<string>>> = {
  'npm-package': new Set(['-w', '--workspace', '--registry', '--prefix', '--filter', '-F', '-C', '--dir', '--cache', '--tag', '--cwd', '--loglevel', '--userconfig', '--globalconfig', '-p', '--package', '-c', '--call', '--omit', '--include', '--save-prefix', '--cafile', '--cert', '--key', '--nodedir', '--store-dir', '--modules-dir', '--virtual-store-dir', '--lockfile-dir', '--global-dir', '--cache-dir', '--cache-folder', '--modules-folder', '--global-folder', '--link-folder', '--script-shell', '--tmp']),
  'python-package': new Set(['-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '--index', '--default-index', '-t', '--target', '-f', '--find-links', '--python', '-p', '--from', '--with', '--with-editable', '--with-requirements', '--prefix', '--root', '--group', '--extra', '--only-binary', '--no-binary', '--trusted-host', '--proxy', '--cache-dir', '--timeout', '--retries', '--upgrade-strategy', '--log', '--file', '--suffix', '--pip-args', '--spec', '--channel', '-n', '--name', '-G']),
};

/**
 * Flags that own the next word for the family but are a switch for one program: pnpm's `-w` is `--workspace-root`, `-n` is `--no-interaction`
 * for poetry and `--no-cache` for uv, and `-f` is `--force` for pipx.
 */
const FLAG_WITHOUT_VALUE: ReadonlySet<string> = new Set(['pnpm -w', 'poetry -n', 'uv -n', 'uvx -n', 'pipx -f']);

/** These tell a runner to use only what is already local, so nothing crosses. */
const NO_FETCH_FLAGS: ReadonlySet<string> = new Set(['--no-install', '--no', '--offline']);

const LOCAL_SPEC = /^(?:\.{1,2}$|\.{0,2}[\\/]|~|[A-Za-z]:[\\/]|file:|link:|workspace:|portal:)/;
const ARCHIVE = /\.(?:whl|tgz|zip|tar\.gz)$/;
const HOSTED = /^(?:github|gitlab|bitbucket|gist):/;
const SCP_URL = /^[^@/\s]+@[^:/\s]+:/;
const VARIABLE = /\$|^%.*%$/;
/** The redactor took the whole word. A mask is not a name, and novelty must not count one. */
const MASKED = /^(?:<(?:secret|email|org-domain)>)+$/;
const namesNothing = (text: string): Spec | null => {
  if (VARIABLE.test(text)) return { kind: 'unread', shape: 'variable-name' };
  return MASKED.test(text) ? { kind: 'unread', shape: 'masked-name' } : null;
};

type Spec = { kind: 'named'; name: string; version: string | null; versionForm: VersionForm; url: boolean } | { kind: 'unread'; shape: UnreadShape };

const versionFormOf = (version: string | null): VersionForm => {
  if (version === null) return 'unstated';
  if (/^v?\d+\.\d+\.\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z.+-]*)?$/.test(version)) return 'pinned';
  if (/^[\^~<>=!*]/.test(version) || /(?:^|\.)(?:x|\*)(?:\.|$)/.test(version) || /[,|\s]/.test(version)) return 'range';
  return 'tag';
};

const GIT_URL = /^(?:git\+|ssh:\/\/|git:\/\/)/i;
/** The first `@` after a URL's host that does not directly follow a `/`, which would be a scope; -1 when there is none. */
const firstRefAt = (stem: string): number => {
  const from = stem.indexOf('/', stem.indexOf('://') + 3);
  if (from < 0) return -1;
  const ref = /(?<!\/)@/g;
  ref.lastIndex = from;
  return ref.exec(stem)?.index ?? -1;
};

/** A query can hold a signed token no pattern knows, and a ref after `#` is the version; neither belongs in a name. */
const urlSpec = (text: string): Spec => {
  const bare = text.replace(/^git\+/, '');
  const hash = bare.indexOf('#');
  const end = hash < 0 ? bare : bare.slice(0, hash);
  const ref = hash < 0 ? null : bare.slice(hash + 1);
  const query = end.indexOf('?');
  const stem = query < 0 ? end : end.slice(0, query);
  // A git URL's `@ref` follows the path and may hold a slash (`@feature/x`), so it starts at the first `@` past the host that is not a
  // scope's (`/@scope`). Any other URL has a ref only after its last slash. An `@` before the path is a credential, never a ref: a word with no path has no ref,
  // and `withoutCredentials` strips its user later.
  const git = GIT_URL.test(text);
  const at = git ? firstRefAt(stem) : stem.lastIndexOf('@');
  const slash = stem.lastIndexOf('/');
  const hasRef = git ? at >= 0 : at > slash && slash > stem.indexOf('://') + 2;
  const name = hasRef ? stem.slice(0, at) : stem;
  const stated = hasRef ? stem.slice(at + 1) : ref === null || ref.startsWith('egg=') ? null : ref;
  return { kind: 'named', name, version: stated, versionForm: 'url', url: true };
};

/**
 * A `file:` spec holds a path on this machine, which has slashes and `://` like a URL: it is read as a folder before any URL test, so no
 * path becomes a name. A name may come before it (`foo@file:...`, `foo @ file:...`), and `link:`, `workspace:`, and `portal:` are folders too.
 */
const FILE_SPEC = /^(?:(?:@[^@/\s]+\/)?[^@/\s]+\s*@\s*)?(?:git\+)?(?:file|link|workspace|portal):/i;
/** pip's PEP 508 direct reference, `name @ url` with spaces: the name before it is only a label, so the URL is what is read. */
const withoutLabel = (text: string): string => text.replace(/^(?:@[^@/\s]+\/)?[^@/\s]+(?:\s+@\s*|\s*@\s+|@(?=git\+))(?=\S)/, '');
const isUrl = (text: string): boolean => text.includes('://') || text.startsWith('git+') || HOSTED.test(text) || SCP_URL.test(text);

const atVersion = (text: string): { name: string; version: string | null } => {
  const at = text.lastIndexOf('@');
  if (at <= 0) return { name: text, version: null };
  return { name: text.slice(0, at), version: text.slice(at + 1) === '' ? null : text.slice(at + 1) };
};

const nodeSpec = (whole: string): Spec => {
  const nothing = namesNothing(whole);
  if (nothing !== null) return nothing;
  const text = withoutLabel(whole);
  // `alias@npm:real@1` installs `real`; the alias is only what the code imports it as. It reads like an scp URL, so it goes first.
  // A leading `npm:` is the same protocol with no alias.
  const alias = /^(?:@?[^@]+@)?npm:(.+)$/.exec(text)?.[1];
  if (alias !== undefined) return nodeSpec(alias);
  // pnpm's leading `jsr:@scope/name[@version]` is the JSR package itself.
  const jsr = /^jsr:(.+)$/.exec(text)?.[1];
  if (jsr !== undefined) return nodeSpec(jsr);
  // pnpm's `catalog:` takes its version from the workspace, and `jsr:` names a version or a JSR package; neither is a path or an scp URL.
  const protocol = /^(@?[^@]+)@(catalog|jsr):(.*)$/.exec(text);
  if (protocol !== null) {
    const [, label = '', kind, rest = ''] = protocol;
    if (kind === 'jsr' && (rest.startsWith('@') || rest.includes('/'))) return nodeSpec(rest);
    const version = kind === 'jsr' && rest !== '' ? rest : null;
    return { kind: 'named', name: label, version, versionForm: versionFormOf(version), url: false };
  }
  if (FILE_SPEC.test(text)) return { kind: 'unread', shape: 'local-path' };
  if (isUrl(text)) return urlSpec(text);
  if (LOCAL_SPEC.test(text) || ARCHIVE.test(text)) return { kind: 'unread', shape: 'local-path' };
  // One slash with no leading `@` is a GitHub shorthand; more than one is a folder.
  const parts = (text.split('#')[0] ?? text).split('/').length;
  if (parts > 2 || text.includes('\\')) return { kind: 'unread', shape: 'local-path' };
  if (parts === 2 && !text.startsWith('@')) return urlSpec(text);
  const { name, version } = atVersion(text);
  return { kind: 'named', name, version, versionForm: versionFormOf(version), url: false };
};

const PYTHON_SPEC = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(===?|~=|!=|>=|<=|<|>)?\s*(.*)$/;

const pythonSpec = (whole: string): Spec => {
  const nothing = namesNothing(whole);
  if (nothing !== null) return nothing;
  const text = withoutLabel(whole);
  if (FILE_SPEC.test(text)) return { kind: 'unread', shape: 'local-path' };
  if (isUrl(text)) return urlSpec(text);
  if (LOCAL_SPEC.test(text) || ARCHIVE.test(text) || /[\\/]/.test(text)) return { kind: 'unread', shape: 'local-path' };
  // uv writes `name@version`, where the `@` is not a PEP 508 direct reference (a URL, handled above).
  const { name: head, version: atStated } = atVersion(text);
  // An environment marker (`;python_version<3`) says where the requirement applies, not which one it is.
  const match = PYTHON_SPEC.exec((head.split(';')[0] ?? head).trim());
  if (match === null) return { kind: 'unread', shape: 'local-path' };
  const [, raw = '', operator = '', stated = ''] = match;
  // Text after the name that no operator introduces is outside PEP 508: refused, never kept as a version.
  if (operator === '' && stated !== '') return { kind: 'unread', shape: 'unreadable-name' };
  // The same holds after the `@`: a word outside PEP 508 there would be kept as a version.
  if (atStated !== null && /[\s#;]/.test(atStated)) return { kind: 'unread', shape: 'unreadable-name' };
  // PEP 503: these spellings are one project, so novelty must not count them twice.
  const name = raw.toLowerCase().replace(/[-_.]+/g, '-');
  if (atStated !== null) return { kind: 'named', name, version: atStated, versionForm: versionFormOf(atStated), url: false };
  if (stated === '') return { kind: 'named', name, version: null, versionForm: 'unstated', url: false };
  const exact = operator === '==' || operator === '===';
  return { kind: 'named', name, version: exact ? stated : `${operator}${stated}`, versionForm: exact ? 'pinned' : 'range', url: false };
};

const specOf = (family: Family, text: string): Spec => (family === 'npm-package' ? nodeSpec(text) : pythonSpec(text));

/** `npm init foo` runs `create-foo`, `npm init @scope/foo` runs `@scope/create-foo`, and `npm init @scope` runs `@scope/create`. */
const creatorSpec = (text: string): string => {
  const { name, version } = atVersion(text);
  const suffix = version === null ? '' : `@${version}`;
  if (!name.startsWith('@')) return `create-${name}${suffix}`;
  const [scope = '', rest] = name.split('/');
  return `${scope}/${rest === undefined ? 'create' : `create-${rest}`}${suffix}`;
};

export interface Words {
  names: string[];
  flags: Map<string, string[]>;
  bare: Set<string>;
}

/**
 * `limit` is how many names a runner's own words take. Once that many are read, every later word is a name, whatever it looks like: it
 * belongs to the fetched program, which may take `-p` or `--package` for its own. Flags before the limit are the runner's.
 */
export const readWords = (command: ShellCommand, family: Family, limit: number = Number.POSITIVE_INFINITY): Words => {
  const names: string[] = [];
  const flags = new Map<string, string[]>();
  const bare = new Set<string>();
  const put = (flag: string, value: string): void => {
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  };
  for (let at = 0; at < command.args.length; at += 1) {
    const { text, quoted } = command.args[at] ?? { text: '', quoted: false };
    if (quoted || !text.startsWith('-') || names.length >= limit) names.push(text);
    else if (text.includes('=')) put(text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1));
    else if (VALUE_FLAGS[family].has(text) && !FLAG_WITHOUT_VALUE.has(`${command.program} ${text}`)) {
      put(text, command.args[at + 1]?.text ?? '');
      at += 1;
    } else bare.add(text);
  }
  return { names, flags, bare };
};

interface VerbRead {
  action: Action;
  rest: string[];
  length: number;
  path: readonly string[];
}

const verbOf = (verbs: Verbs, names: readonly string[]): VerbRead | null => {
  let best: VerbRead | null = null;
  for (const [path, action] of verbs) {
    if ((best === null || path.length > best.length) && path.every((word, at) => names[at] === word)) best = { action, rest: names.slice(path.length), length: path.length, path };
  }
  return best;
};

const allFlags = (words: Words, ...names: readonly string[]): string[] => names.flatMap((name) => words.flags.get(name) ?? []);

const PIP_NAME = /^pip[\d.]*$/;
const PYTHON_NAME = /^(?:python[\d.]*|py)$/;
const MODULE_NAME = /^(?:pip[\d.]*|pipx|uv)$/;
type ModuleProgram = 'pip' | 'pipx' | 'uv';
const MODULE_PROGRAMS: { readonly [name in ModuleProgram]: Program } = { pip: 'python -m pip', pipx: 'python -m pipx', uv: 'python -m uv' };

/** `python -m pip ...` is `pip ...`, and `-m pipx` and `-m uv` the same. The words before `-m` are the interpreter's own flags. */
const moduleCommand = (command: ShellCommand): { module: ModuleProgram; command: ToolCommand } | null => {
  if (!PYTHON_NAME.test(command.program)) return null;
  const at = command.args.findIndex((word) => word.text === '-m');
  const name = command.args[at + 1]?.text ?? '';
  if (at < 0 || !MODULE_NAME.test(name)) return null;
  const module = name === 'pipx' || name === 'uv' ? name : 'pip';
  return { module, command: { ...command, program: module, args: command.args.slice(at + 2) } };
};

const PIP_TOOL: Tool = { family: 'python-package', verbs: PIP_VERBS };
/** The listed program a word names, with its table row. `pip3.12` is `pip`. */
const toolOf = (program: string): { program: ToolProgram; tool: Tool } | undefined => {
  const named = PIP_NAME.test(program) ? 'pip' : program;
  for (const [key, tool] of TOOLS) if (key === named) return { program: key, tool };
  return undefined;
};

const SHELL_SINK = /^(?:sh|bash|zsh|dash|python[\d.]*|node|iex|invoke-expression|pwsh|powershell)$/;
const FETCHER = /^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)$/;

interface Reading {
  crossings: Crossing[];
  unread: UnreadShape[];
  removals: Removal[];
}

const emptyReading = (): Reading => ({ crossings: [], unread: [], removals: [] });

const crossingOf = (family: Family, spec: Extract<Spec, { kind: 'named' }>, action: 'install' | 'run', program: Program, statusReports: boolean): Crossing => {
  const form: CrossingForm = action === 'run' ? (spec.url ? 'url-fetch-and-run' : 'fetch-and-run') : spec.url ? 'url-install' : 'install';
  return { class: family, form, name: spec.name, version: spec.version, versionForm: spec.versionForm, program, statusReports, registryAsked: true };
};

const addSpecs = (reading: Reading, family: Family, texts: readonly string[], action: 'install' | 'run', program: Program, statusReports: boolean): void => {
  for (const text of texts) {
    const spec = specOf(family, text);
    if (spec.kind === 'unread') reading.unread.push(spec.shape);
    else reading.crossings.push(crossingOf(family, spec, action, program, statusReports));
  }
};

/** `npx skills add` flags that take a value, so the word after one is not the source. */
const SKILL_VALUE_FLAGS: ReadonlySet<string> = new Set(['-s', '--skill', '-a', '--agent']);

/** The first word after `add` that is neither a flag nor a flag's value. */
const skillSource = (words: readonly string[]): string | undefined => {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (SKILL_VALUE_FLAGS.has(word)) at += 1;
    else if (!word.startsWith('-')) return word;
  }
  return undefined;
};

const readRun = (reading: Reading, family: Family, words: Words, rest: readonly string[], command: ToolCommand): void => {
  if ([...NO_FETCH_FLAGS].some((flag) => words.bare.has(flag))) return;
  const [first, sub] = rest;
  const source = sub === 'add' ? skillSource(rest.slice(2)) : undefined;
  if (first !== undefined && atVersion(first).name === 'skills' && source !== undefined) {
    if (FILE_SPEC.test(source)) {
      reading.unread.push('local-path');
      return;
    }
    // `owner/repo@skill` picks one skill of a source: the source is what crosses.
    const picked = /^([^@:\s]+\/[^@:\s]+)@[^@/:\s]+$/.exec(source)?.[1] ?? source;
    const spec = namesNothing(picked) ?? (isUrl(picked) ? urlSpec(picked) : null);
    if (spec?.kind === 'unread') reading.unread.push(spec.shape);
    else if (!LOCAL_SPEC.test(picked)) reading.crossings.push({ class: 'skill', form: 'install', name: spec?.name ?? picked, version: null, versionForm: 'unstated', program: command.program, statusReports: command.read, registryAsked: true });
    return;
  }
  const packaged = family === 'npm-package' ? allFlags(words, '-p', '--package') : allFlags(words, '--from', '--spec');
  if (packaged.length > 0) addSpecs(reading, family, packaged, 'run', command.program, command.read);
  else if (first !== undefined) addSpecs(reading, family, [first], 'run', command.program, command.read);
};

const readRemoval = (reading: Reading, family: Family, names: readonly string[]): void => {
  for (const text of names) {
    const spec = specOf(family, text);
    if (spec.kind === 'named') reading.removals.push({ class: family, name: spec.name });
  }
};

const readInstall = (reading: Reading, family: Family, words: Words, rest: readonly string[], command: ToolCommand): void => {
  const editable = allFlags(words, '-e', '--editable');
  const texts = [...editable, ...rest];
  if (texts.length === 0 || allFlags(words, '-r', '--requirement', '--file').length > 0) reading.unread.push('manifest-install');
  addSpecs(reading, family, texts, 'install', command.program, command.read);
};

/** A creator is a plain name that gets `create-` put before it; a path, a URL, or `org/repo` is no creator and is not prefixed into a name. */
const readCreator = (reading: Reading, family: Family, text: string, command: ToolCommand): void => {
  const spec = nodeSpec(text);
  if (spec.kind === 'unread') reading.unread.push(spec.shape);
  else if (spec.url) reading.unread.push('unreadable-name');
  else addSpecs(reading, family, [creatorSpec(text)], 'run', command.program, command.read);
};

const readTool = (reading: Reading, tool: Tool, command: ToolCommand): void => {
  const { family } = tool;
  let words = readWords(command, family);
  // A bare `yarn` is its install; `yarn foo` runs a script.
  if (command.program === 'yarn' && words.names.length === 0) {
    reading.unread.push('manifest-install');
    return;
  }
  // `uv run --with a` installs into a throwaway environment and runs: a fetch-and-run, whatever the script is.
  if (command.program === 'uv' && words.names[0] === 'run') {
    // `uv run pip install x` is the same pick as `pip install x`: read it as that. Any other program after `run` stays unread.
    // It stays recorded under `uv`: uv's pip runs in the project venv and reads that venv's `pip.conf`, so the registry question must refuse it.
    addSpecs(reading, family, allFlags(words, '--with'), 'run', command.program, command.read);
    // A flag may sit between the two (`pip -q install x`).
    const pip = command.args.findIndex((word, at) => word.text === 'pip' && command.args.slice(at + 1).find((next) => !next.text.startsWith('-'))?.text === 'install');
    if (words.names[1] === 'pip' && words.names[2] === 'install' && pip >= 0) readTool(reading, PIP_TOOL, { ...command, args: command.args.slice(pip + 1) });
    return;
  }
  // `yarn workspace <name> add x` is `yarn add x` run in that workspace: two words that are not the verb's.
  const stripped = command.program === 'yarn' && words.names[0] === 'workspace' ? 2 : 0;
  if (stripped > 0) words = { ...words, names: words.names.slice(stripped) };
  let verb = verbOf(tool.verbs, words.names);
  if (verb === null) return;
  // Past the runner's own word, the flags are the fetched program's: read again, with the rest left as names.
  if (verb.action === 'run') {
    const again = readWords(command, family, stripped + verb.length + 1);
    words = { ...again, names: again.names.slice(stripped) };
    verb = verbOf(tool.verbs, words.names) ?? verb;
  }
  const toolForm = command.program === 'uvx' || (command.program === 'uv' && verb.path[0] === 'tool');
  if (verb.action === 'manifest') reading.unread.push('manifest-install');
  else if (verb.action === 'remove') readRemoval(reading, family, verb.rest);
  else if (verb.action === 'install') readInstall(reading, family, words, verb.path[0] === 'inject' ? verb.rest.slice(1) : verb.rest, command);
  else if (verb.action === 'run') readRun(reading, family, words, verb.rest, command);
  else if (verb.rest[0] !== undefined) readCreator(reading, family, verb.rest[0], command);
  // uv's tool forms take extra packages with `--with`; they install beside the tool.
  if (toolForm && (verb.action === 'run' || verb.action === 'install')) addSpecs(reading, family, allFlags(words, '--with'), verb.action, command.program, command.read);
};

const namesOf = (command: ShellCommand): string[] => command.args.filter((word) => !word.text.startsWith('-')).map((word) => word.text);

/** Names no package, and says a crossing's shape went by: the name is behind a pipe, or the harness took it. */
const readShape = (reading: Reading, command: ShellCommand, previous: ShellCommand | undefined): void => {
  const names = namesOf(command);
  if (previous?.link === 'pipe' && FETCHER.test(previous.program) && SHELL_SINK.test(command.program)) reading.unread.push('pipe-to-shell');
  if (command.program === 'xargs') {
    const at = names.findIndex((name) => toolOf(name) !== undefined);
    const found = toolOf(names[at] ?? '');
    if (found !== undefined && verbOf(found.tool.verbs, names.slice(at + 1))?.action === 'install') reading.unread.push('behind-xargs');
  }
  if (command.program === 'claude' || command.program === 'codex') {
    const [first, second] = names;
    if ((first === 'mcp' || first === 'plugin') && (second === 'add' || second === 'install')) reading.unread.push('harness-registration');
  }
};

const readCommand = (reading: Reading, command: ShellCommand, previous: ShellCommand | undefined): void => {
  readShape(reading, command, previous);
  const viaModule = moduleCommand(command);
  const found = viaModule === null ? toolOf(command.program) : toolOf(viaModule.module);
  if (found === undefined) return;
  const direct: ToolCommand = { ...(viaModule?.command ?? command), program: found.program };
  const from = reading.crossings.length;
  readTool(reading, found.tool, direct);
  // `python -m pip` is how a call goes around a stopped `pip`, so a record has to keep the two apart.
  if (viaModule !== null) for (const crossing of reading.crossings.slice(from)) crossing.program = MODULE_PROGRAMS[viaModule.module];
};

const stringField = (input: unknown, key: string): string | undefined => {
  const value: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** A flag that points a manager at another registry, config, or folder, so its config is not the one the gate's question would read. */
const REGISTRY_FLAGS: ReadonlySet<string> = new Set(['--registry', '-i', '--index-url', '--extra-index-url', '--index', '--default-index', '--userconfig', '--globalconfig', '--prefix', '-C', '--dir', '-f', '--find-links', '--no-index']);
/** `--@scope:registry=url` sends one scope elsewhere. */
const SCOPE_REGISTRY = /^--@[^=\s]*:registry(?:=|$)/;
/** `--config.registry=url` (pnpm) and `--config.@scope:registry=url`, and `-ihttps://...` with the value attached. */
const CONFIG_REGISTRY = /^--config\.[^=\s]*registry(?:=|$)/;
const ATTACHED_INDEX = /^-i./;
/** PowerShell's own folder stack. Local to the gate: `CHANGES_FOLDER` also drives capture's read-back of the working folder. */
const FOLDER_STACK = new Set(['push-location', 'pop-location']);
/** An assignment of a manager's own variable, in any shell's spelling, which can name a registry or a config file. Over-matching only leaves a name unasked. */
const REGISTRY_ENVIRONMENT = /(?:^|[^A-Za-z0-9_])(?:(?:npm_config_|pip_|uv_)[A-Za-z0-9_]*|home|userprofile|xdg_config_home|xdg_config_dirs|appdata|path|virtual_env)\s*=/i;
/**
 * Other ways a call reads another config than the one the gate's question reads: `sudo` (root's), a venv's `activate` (its `pip.conf`), and
 * a manager run by path (`.venv/bin/pip`, which reads that venv's). Over-matching only leaves a name unasked.
 */
const OTHER_CONFIG = /(?:^|[\s;&|(])sudo(?:\s|$)|(?:^|[\\/\s;&|("'])activate(?:\.\w+)?(?=["'\s;&|)]|$)|[\\/](?:npm|npx|pnpm|pnpx|pip[\d.]*|python[\d.]*|py)(?:\.cmd|\.exe|\.bat)?(?=["']?(?:\s|$))/i;

const choosesRegistry = (command: ShellCommand): boolean => command.args.some(({ text }) => REGISTRY_FLAGS.has(text.split('=')[0] ?? '') || SCOPE_REGISTRY.test(text) || CONFIG_REGISTRY.test(text) || ATTACHED_INDEX.test(text) || /(?:^|@)jsr:/.test(text));

const checkShell = (input: unknown, redact: Redactor): CallCheck => {
  const command = stringField(input, 'command');
  const reading = emptyReading();
  if (command === undefined) return reading;
  const commands = shellCommands(command, redact);
  const environment = REGISTRY_ENVIRONMENT.test(command) || OTHER_CONFIG.test(command);
  let moved = false;
  commands.forEach((held, at) => {
    const from = reading.crossings.length;
    readCommand(reading, held, commands[at - 1]);
    if (environment || moved || choosesRegistry(held)) {
      for (const crossing of reading.crossings.slice(from)) crossing.registryAsked = false;
    }
    moved ||= CHANGES_FOLDER.has(held.program) || FOLDER_STACK.has(held.program);
  });
  return reading;
};

export type Admitted = { kind: 'named'; name: string } | { kind: 'unread'; shape: UnreadShape };

// The grammar of a name, by family. The readers above recognize shapes; these decide what may be written, so a spelling no reader has
// met yet cannot put a path into `crossings.jsonl` or a question to a registry.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PEP508_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const MCP_NAME = /^[a-z0-9_][a-z0-9._-]*$/i;
const SKILL_NAME = /^[a-z0-9_][a-z0-9._:-]*$/i;
const NAME_LENGTH = 214;
/** The harness and a skill's author name these in a line or two; nothing near the length of a package's limit. */
const LABEL_LENGTH = 128;
const SEGMENT = '[A-Za-z0-9._-]+';
/** A segment that is not `.` or `..`: those two name a folder, never an owner, a repository, or a part of a URL's path. */
const PLAIN = String.raw`(?!(?:\.|%2[eE]){1,2}(?:/|$))`;
/** An owner starts with a letter or digit, so `.secret/x` and `C:x` are not `owner/repo`. */
const OWNER = '[A-Za-z0-9][A-Za-z0-9_-]*';
const MASK = '<(?:secret|email|org-domain)>';
/** A host starts with a letter, a digit, or a mask, so `..` and `-x` are not hosts. */
const HOST = String.raw`(?:[A-Za-z0-9]|${MASK})(?:[A-Za-z0-9.-]|${MASK})*`;
const URL_CHARS = String.raw`(?:[A-Za-z0-9._~%+-]|${MASK})*`;
/** An `@` in a path opens a segment (a scope, `/@scope`) and is followed by a name: one that ends a segment or sits inside one is a ref or a path. */
const URL_SEGMENT = String.raw`/${PLAIN}(?:@(?![/@]|$))?${URL_CHARS}`;
/**
 * A URL keeps a scheme, a host, and a path: no credentials, query, or fragment. `ssh://` and `git://` also take npm's scp spelling,
 * `host:owner/repo`, where an `https` URL takes only a port. No segment of the path is `.` or `..`.
 */
const URL_NAME = new RegExp(String.raw`^(?:https?://${HOST}(?::\d+)?|(?:ssh|git)://${HOST}(?::${OWNER}(?:\.[A-Za-z0-9_-]+)*)?)(?:${URL_SEGMENT})*$`, 'i');
/** `host:path`, with a host of at least two characters, so `C:secret/x` is a drive and never a host. */
const SCP_NAME = new RegExp(String.raw`^(?=[^:]{2})${HOST}:${PLAIN}${SEGMENT}(?:/${PLAIN}${SEGMENT})*$`);
const HOSTED_NAME = new RegExp(String.raw`^(?:github|gitlab|bitbucket|gist):${PLAIN}${SEGMENT}(?:/${PLAIN}${SEGMENT})?$`);
const SHORTHAND_NAME = new RegExp(String.raw`^${OWNER}/${PLAIN}${SEGMENT}$`);
/** A skill source is a hosted `owner/repo`, optionally into a folder, or a URL. */
const SKILL_SOURCE = new RegExp(String.raw`^${OWNER}(?:/${PLAIN}${SEGMENT}){1,5}$`);
/** A URL's ref is a tag, a branch, or a commit, and `semver:` ranges: anything else could carry a path or a parameter. */
const PLAIN_REF = /^(?:semver:)?[\w.^~*+-]+$/;
/** A version that is not a URL's ref has none of a slash, a backslash, `:`, or `@`: those mark a path or a spec, not a version. */
const VERSION = /^[^/\\:@]*$/;

const withoutCredentials = (name: string): string =>
  name
    .replace(/[?#].*$/, '')
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1')
    .replace(/^[^@/\s:]+@(?=[^:/\s]+:)/, '');

/** What a word outside every grammar is: a path when it holds a separator, a scheme, or an `@` past the scope. */
const shapeOfJunk = (name: string): UnreadShape => {
  if (VARIABLE.test(name)) return 'variable-name';
  if (MASKED.test(name)) return 'masked-name';
  return /[\\/]|^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) || name.slice(1).includes('@') ? 'local-path' : 'unreadable-name';
};

const grammarOf = (cls: CrossingClass, form: CrossingForm | 'removal', name: string): boolean => {
  if (name.length > (cls === 'mcp-server' || (cls === 'skill' && form === 'skill-call') ? LABEL_LENGTH : NAME_LENGTH)) return false;
  if (cls === 'mcp-server') return MCP_NAME.test(name);
  if (cls === 'skill') return form === 'skill-call' ? SKILL_NAME.test(name) : SKILL_SOURCE.test(name) || URL_NAME.test(name);
  if (form === 'url-install' || form === 'url-fetch-and-run') return URL_NAME.test(name) || SCP_NAME.test(name) || HOSTED_NAME.test(name) || SHORTHAND_NAME.test(name);
  return (cls === 'npm-package' ? NPM_NAME : PEP508_NAME).test(name);
};

/**
 * The one point every recorded name passes, before it reaches `crossings.jsonl`, a registry question, or a removal match. A name outside
 * its family's grammar is never written and never asked: it is counted by the shape it has. A URL loses its credentials, query, and
 * fragment first.
 */
export const admitName = (cls: CrossingClass, form: CrossingForm | 'removal', name: string): Admitted => {
  const urlForm = form === 'url-install' || form === 'url-fetch-and-run' || (cls === 'skill' && form === 'install');
  const kept = urlForm ? withoutCredentials(name) : name;
  return grammarOf(cls, form, kept) ? { kind: 'named', name: kept } : { kind: 'unread', shape: shapeOfJunk(kept) };
};

const admitted = (check: CallCheck): CallCheck => {
  const unread = [...check.unread];
  const crossings: Crossing[] = [];
  for (const crossing of check.crossings) {
    const verdict = admitName(crossing.class, crossing.form, crossing.name);
    if (verdict.kind === 'unread') unread.push(verdict.shape);
    else if (crossing.versionForm !== 'url' && crossing.version !== null && !VERSION.test(crossing.version)) unread.push('local-path');
    else crossings.push({ ...crossing, name: verdict.name, version: crossing.versionForm === 'url' && crossing.version !== null && !PLAIN_REF.test(crossing.version) ? null : crossing.version });
  }
  const removals = check.removals.filter((removal) => admitName(removal.class, 'removal', removal.name).kind === 'named');
  return { crossings, unread, removals };
};

/** The harness's own tool names: a shell call and the two tools that name a pick. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

/** What each tool call states, before the grammar of `admitName`. */
const readCall = (call: ToolCall, redact: Redactor): CallCheck => {
  if (SHELL_TOOLS.has(call.tool)) return checkShell(call.input, redact);
  if (call.tool.startsWith('mcp__')) {
    const server = call.tool.split('__')[1] ?? '';
    if (server === '') return emptyReading();
    return { ...emptyReading(), crossings: [{ class: 'mcp-server', form: 'mcp-call', name: redact(server), version: null, versionForm: 'unstated', program: 'mcp', statusReports: true, registryAsked: true }] };
  }
  const skill = call.tool === 'Skill' ? (stringField(call.input, 'skill') ?? stringField(call.input, 'command')) : undefined;
  if (skill === undefined) return emptyReading();
  return { ...emptyReading(), crossings: [{ class: 'skill', form: 'skill-call', name: redact(skill), version: null, versionForm: 'unstated', program: 'skill', statusReports: true, registryAsked: true }] };
};

/** Names the crossing a tool call makes, if any. The later hook calls this same function with the call it is handed. */
export const checkCall = (call: ToolCall, redact: Redactor): CallCheck => admitted(readCall(call, redact));
