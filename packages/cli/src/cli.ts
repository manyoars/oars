import { randomUUID } from 'node:crypto';
import { Command, CommanderError, InvalidArgumentError, type OptionValues } from 'commander';
import { resolveApiUrl } from './api.js';
import { keysCreate, keysList, keysRevoke, SCOPED_AUTHORITIES } from './commands/keys.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import type { CredentialStore } from './credentials.js';
import { CliError, ExitCode } from './errors.js';
import type { BooksBy, RecallQuery } from './sessions/query.js';
import { closedQueryOf, formsRefusal, RECALL_FAMILIES } from './sessions/recall-reads.js';
import { FAMILIES } from './sessions/read.js';
import { sessionsBooks, sessionsContext, sessionsDeposit, sessionsGoldArms, sessionsGoldSample, sessionsGoldScore, sessionsHookInstall, sessionsHookStatus, sessionsHookUninstall, sessionsMcp, sessionsLineage, sessionsMeasure, sessionsRead, sessionsRecall, sessionsReceipt, sessionsRecallCounts, sessionsVerify, type SessionsDeps } from './sessions/command.js';
import { sessionsCard } from './sessions/card-command.js';
import type { CardPeriod } from './sessions/card.js';
import { gateInstall, gatePolicy, gateReplay, gateReport, gateUninstall } from './gate/command.js';
import { DEADLINE_MS, gateHook } from './gate/hook.js';
import { managerReader } from './gate/registry.js';
import { exclusionPaths, sessionsExclusions } from './sessions/exclusion.js';
import { sessionsTry } from './sessions/try.js';
import { githubVisibility, poolEnroll, poolMachineRevoke, poolMachines } from './sessions/machine-enroll.js';
import { runNetGit } from './sessions/machine-hold.js';
import { holdPull } from './sessions/machine-pull.js';
import { runGit } from './sessions/survival.js';
import { poolCoverage, poolDeposit, poolExport, poolFetch, poolLogin, poolLogout, poolOutbox, poolProve, poolRaw } from './sessions/pool-command.js';
import type { InstallRuntime, Scope } from './sessions/install.js';
import type { SessionsRuntime } from './sessions/store.js';
import { telemetryOff, telemetryOn, telemetryReport, telemetryShow, telemetryStatus } from './telemetry/command.js';
import { cardLine } from './sessions/card-line.js';
import type { CardLineArm } from './telemetry/schema.js';
import { recordCrash } from './telemetry/crash.js';
import { emitOf } from './telemetry/emit.js';
import { finishTelemetry, isHook, observeCommand, type Observed } from './telemetry/observe.js';
import type { TelemetryRuntime } from './telemetry/record.js';

/** Everything the CLI takes from its process, so the tests can stand in for each. */
export interface RunDeps {
  env: NodeJS.ProcessEnv;
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  store: CredentialStore;
  /** Sent as `User-Agent: oars/<version>` and printed by `--version`. */
  version: string;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1), for retry jitter. */
  random: () => number;
  /** Epoch milliseconds. */
  now: () => number;
  openBrowser: (url: string) => Promise<void>;
  /** Where `oars sessions` keeps its store and finds the operator's Claude Code logs; absent in a run that has none. */
  sessions?: SessionsRuntime;
  /** Where `oars sessions hook` finds the hook script, the settings files, and schtasks; absent in a run that has none. */
  install?: InstallRuntime;
  /** Where telemetry keeps its id, settings, and spool; absent in a run that has none, which records nothing. */
  telemetry?: TelemetryRuntime | undefined;
  /** The catch-up every command that is not a hook runs after it ends: starts a due sweep and send, detached. Absent in a run that has none. */
  catchUp?: (() => Promise<unknown>) | undefined;
}

/** What a command produced: the `--json` document, and the line a human sees instead. */
export interface Outcome {
  document: object;
  text: string;
}

const flag = (options: OptionValues, name: string): boolean => options[name] === true;

const text = (options: OptionValues, name: string): string | undefined => {
  const value: unknown = options[name];
  return typeof value === 'string' ? value : undefined;
};

const list = (options: OptionValues, name: string): string[] => {
  const value: unknown = options[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const count = (options: OptionValues, name: string): number | undefined => {
  const value: unknown = options[name];
  return typeof value === 'number' ? value : undefined;
};

/** A repeatable option's collector: each use adds one value. */
const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

const positiveInteger = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError('it must be a positive whole number.');
  return Number(value);
};

/** An ISO time, normalized to the form session timestamps are stored in so the two compare as text. */
const isoTime = (value: string): string => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new InvalidArgumentError('it must be an ISO time such as 2026-11-01T16:00:00Z.');
  return new Date(parsed).toISOString();
};

const emit = (deps: RunDeps, json: boolean, outcome: Outcome): void => {
  deps.io.stdout(`${json ? JSON.stringify(outcome.document) : outcome.text}\n`);
};

/**
 * `--json` prints `{ok: false, step, problem}` on stdout, plus the error's details; otherwise the problem's title, detail,
 * and URL go to stderr.
 */
const printFailure = (deps: RunDeps, json: boolean, error: CliError): void => {
  if (json) {
    deps.io.stdout(`${JSON.stringify({ ok: false, step: error.step, problem: error.problem, ...error.details })}\n`);
    return;
  }
  const { title, detail, actionUrl } = error.problem;
  deps.io.stderr(`${[title ?? error.message, detail, actionUrl].filter((line) => line !== undefined && line !== '').join('\n')}\n`);
};

const sessionDeps = (deps: RunDeps): SessionsDeps => ({ sessions: deps.sessions, install: deps.install, now: deps.now, telemetry: emitOf(deps) });

const buildProgram = (deps: RunDeps, observed: Observed): Command => {
  const program = new Command('oars')
    .description('Many Oars: sign in, manage API keys, and keep a local, searchable record of your own coding-agent sessions')
    .version(deps.version)
    .exitOverride()
    .configureOutput({ writeOut: deps.io.stdout, writeErr: deps.io.stderr })
    .option('--json', 'print one JSON document on stdout instead of text')
    .option('--api-url <url>', 'the platform API (default: OARS_API_URL, else https://api.manyoars.com)')
    .option('--idempotency-key <key>', "the base of the idempotency key (default: a fresh UUID); rerun a failed command with the same key to replay it")
    .hook('preAction', (_program, action) => {
      observeCommand(observed, action);
    });

  program
    .command('login')
    .description('sign in with your browser (RFC 8628 device flow)')
    .option('--no-browser', 'print the link and code without opening a browser')
    .option('--issuer-url <url>', 'the Keycloak realm URL (default: OARS_ISSUER_URL, else the Many Oars issuer)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const outcome = await login(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        browser: options.browser !== false,
        ...(text(options, 'issuerUrl') === undefined ? {} : { issuerUrl: text(options, 'issuerUrl') }),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  program
    .command('logout')
    .description('revoke the stored login and delete it')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await logout(deps));
    });

  const keys = program.command('keys').description('create, list, and revoke your API keys; a key made with --workload works on that one workload only');

  keys
    .command('create')
    .description('create an API key and print its secret once; --workload limits it to one workload you created')
    .requiredOption('--name <name>', 'a name to recognize the key by')
    .option('--workload <id>', 'limit the key to this workload (it may then carry only AGENT_OPERATE and AGENT_READ)')
    .option('--authority <name>', 'an authority for the key (repeatable; default AGENT_OPERATE and AGENT_READ)', collect)
    .option('--expires-in-days <n>', 'days until the key expires', positiveInteger)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const authorities = list(options, 'authority');
      const outcome = await keysCreate(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        name: text(options, 'name') ?? '',
        authorities: authorities.length === 0 ? SCOPED_AUTHORITIES : authorities,
        idempotencyKey: text(options, 'idempotencyKey') ?? randomUUID(),
        ...(text(options, 'workload') === undefined ? {} : { workloadId: text(options, 'workload') }),
        ...(count(options, 'expiresInDays') === undefined ? {} : { expiresInDays: count(options, 'expiresInDays') }),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  keys
    .command('list')
    .description('list your API keys (the secrets are never shown again)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await keysList(deps, { apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')) }));
    });

  keys
    .command('revoke')
    .description('revoke an API key at once')
    .argument('<keyId>', 'the key id that `keys list` prints')
    .action(async (keyId: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await keysRevoke(deps, { apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')), keyId }));
    });

  program
    .command('card')
    .description('a share-ready card of your own week, month, or year across every harness, read from your local store only: nothing is uploaded and no folder, path, prompt text, or private name is printed')
    .option('--week', 'the last 7 days (the default)')
    .option('--month', 'the last 30 days')
    .option('--year', 'the last 365 days')
    .option('--text', 'print the card as a table instead of saving a picture')
    .option('--out <file>', 'save the card here, as .png or .svg: both are written, one with each extension (default oars-card-<period> in the working directory)')
    .option('--no-cost', 'leave the cost row out of the picture, the table, and --json')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const period: CardPeriod = flag(options, 'year') ? 'year' : flag(options, 'month') ? 'month' : 'week';
      emit(deps, flag(options, 'json'), await sessionsCard(sessionDeps(deps), { period, text: flag(options, 'text'), out: text(options, 'out'), noCost: options.cost === false }, deps.env));
    });

  const sessions = program.command('sessions').description("deposit and recall your own coding-agent session logs, locally (these commands make no model call and no network call, except `gold arms`, which asks your own Claude subscription; telemetry is separate: oars telemetry)");

  sessions
    .command('deposit')
    .description('read session logs into the local observation log, from every folder unless --allow names some or --deny keeps some out; idempotent. Subagent transcripts under each session (<project>/<session>/subagents/) are deposited with their parent, and each raw transcript is hard-linked or copied into the oars archive beside the store')
    .option('--allow <folder>', 'a project folder to read: its path, or its name under ~/.claude/projects (repeatable); `cursor`, `codex`, `copilot`, `gemini`, `grok`, `opencode`, `pi`, `vscode-copilot`, and `otel` name the Cursor, Codex, Copilot CLI, Gemini CLI, Grok Build, OpenCode, Pi, VS Code Copilot Chat, and OpenTelemetry GenAI trace stores. A trailing slash names everything under a folder; * and ? are wildcards', collect)
    .option('--allow-file <list>', 'a file of --allow entries, one per line (# starts a comment, and !<entry> keeps a folder out); repeatable, combines with --allow', collect)
    .option('--deny <folder>', 'a folder never to read, in any form --allow takes (repeatable); saved, and it wins over every --allow until that exact entry is named with --allow', collect)
    .option('--redact-domain <domain>', 'an organization domain to mask in everything written (repeatable)', collect)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(
        deps,
        flag(options, 'json'),
        await sessionsDeposit(sessionDeps(deps), { allow: list(options, 'allow'), allowFiles: list(options, 'allowFile'), deny: list(options, 'deny'), redactDomains: list(options, 'redactDomain') }),
      );
    });

  sessions
    .command('try')
    .description('see recall, books, and the hook line work on made-up sessions, with no history of your own: it builds a throwaway store under your temp folder, labels everything it prints as synthetic, and deletes the store when it exits. It never reads or writes your real store')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      // The command promises no network call: drop the sender before it runs, so the daily telemetry send that follows every command cannot start one, whether the run returns or throws.
      if (deps.telemetry !== undefined) deps.telemetry = { dir: deps.telemetry.dir, platform: deps.telemetry.platform };
      emit(deps, flag(options, 'json'), await sessionsTry(deps));
    });

  sessions
    .command('recall')
    .description('look a tool error, a file, or a prompt class up in the store (--mcp serves the same query to a running agent). Note: an error pasted with a leading <tool_use_error> line does not match a stored signature, because the extractor keeps that markup line as the signature (reference-script behavior); paste the line below it')
    .option('--error <text>', 'an error as printed; matched by its normalized signature')
    .option('--path <file>', 'a file path or name that earlier sessions touched')
    .option('--class <name>', 'a prompt class (edit-verify, edit-only, shell-only, research, orchestration, explore-only, mixed, no-tools)')
    .option('--since <days>', 'only the last N days', positiveInteger)
    .option('--pattern <id>', 'what happened from here: a read ID for a step so far (repeatable)', collect)
    .option('--entity <name>', 'what is known about a public name: a package, a tool, an MCP server, an action, or a model')
    .option('--family <name>', `one read family (${RECALL_FAMILIES.join(', ')}); only recovery and fit are narrowed by --class and --since`)
    .option('--text <text>', 'look for text in the local record')
    .option('--session <id>', 'the session asking, so what it did next can be read for this recall')
    .option('--receipt', 'with --error: print a redacted Markdown block to paste into an issue on the failing tool (tool, harness, normalized signature, earlier sessions and weeks, what they did next)')
    .option('--counts', 'print counts of recalls by mode, arm, and answer, with how many windows hold a call named like a shown action, instead of answering (see --day)')
    .option('--day <yyyy-mm-dd>', 'with --counts: only this UTC day')
    .option('--mcp', 'serve one recall tool over MCP on stdio instead of answering once')
    .option('--context', "print the repository's top recurring errors as a short block for injection into a session (see --cwd, --harness, --top, --max-chars)")
    .option('--cwd <dir>', "with --context: the session's working directory (default: this one)")
    .option('--harness <version>', 'with --context: only errors seen under this Claude Code version')
    .option('--top <n>', 'with --context: how many signatures (default 5)', positiveInteger)
    .option('--max-chars <n>', "with --context: the block's length limit (default 1200)", positiveInteger)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      if (flag(options, 'receipt')) {
        if (flag(options, 'counts') || flag(options, 'mcp') || flag(options, 'context') || list(options, 'pattern').length > 0 || text(options, 'entity') !== undefined || text(options, 'family') !== undefined || text(options, 'text') !== undefined) throw new CliError('--receipt answers one error: pass --error "<text>" and no other form.', ExitCode.USAGE, 'usage');
        emit(deps, flag(options, 'json'), await sessionsReceipt(sessionDeps(deps), { ...(text(options, 'error') === undefined ? {} : { error: text(options, 'error') }), ...(text(options, 'path') === undefined ? {} : { path: text(options, 'path') }), ...(text(options, 'class') === undefined ? {} : { cls: text(options, 'class') }), ...(count(options, 'since') === undefined ? {} : { sinceDays: count(options, 'since') }) }, text(options, 'session') ?? null));
        return;
      }
      if (flag(options, 'counts')) {
        emit(deps, flag(options, 'json'), await sessionsRecallCounts(sessionDeps(deps), text(options, 'day')));
        return;
      }
      if (flag(options, 'context')) {
        emit(
          deps,
          flag(options, 'json'),
          await sessionsContext(sessionDeps(deps), {
            cwd: text(options, 'cwd') ?? process.cwd(),
            ...(text(options, 'harness') === undefined ? {} : { harness: text(options, 'harness') }),
            top: count(options, 'top') ?? 5,
            maxChars: count(options, 'maxChars') ?? 1200,
          }),
        );
        return;
      }
      if (flag(options, 'mcp')) {
        await sessionsMcp(sessionDeps(deps));
        return;
      }
      const session = text(options, 'session') ?? null;
      const conflict = formsRefusal([
        ...(list(options, 'pattern').length > 0 ? ['prefix' as const] : []),
        ...(text(options, 'entity') === undefined ? [] : ['entity' as const]),
        ...(text(options, 'family') === undefined ? [] : ['family' as const]),
        ...(text(options, 'text') === undefined ? [] : ['text' as const]),
        ...(text(options, 'error') === undefined && text(options, 'path') === undefined ? [] : ['error or path' as const]),
      ]);
      if (conflict !== undefined) throw new CliError(conflict, ExitCode.USAGE, 'usage');
      const closed = closedQueryOf({ pattern: list(options, 'pattern'), entity: text(options, 'entity'), family: text(options, 'family'), text: text(options, 'text'), cls: text(options, 'class'), sinceDays: count(options, 'since') });
      if (closed !== undefined) {
        emit(deps, flag(options, 'json'), await sessionsRecall(sessionDeps(deps), closed, session));
        return;
      }
      const query: RecallQuery = {
        ...(text(options, 'error') === undefined ? {} : { error: text(options, 'error') }),
        ...(text(options, 'path') === undefined ? {} : { path: text(options, 'path') }),
        ...(text(options, 'class') === undefined ? {} : { cls: text(options, 'class') }),
        ...(count(options, 'since') === undefined ? {} : { sinceDays: count(options, 'since') }),
      };
      emit(deps, flag(options, 'json'), await sessionsRecall(sessionDeps(deps), query, session));
    });

  sessions
    .command('lineage <id>')
    .description('walk a recall or read back through its evidence, one line per hop with its frame range and day; refuses evidence newer than the recall')
    .action(async (id: string, _options: OptionValues, command: Command) => {
      emit(deps, flag(command.optsWithGlobals(), 'json'), await sessionsLineage(sessionDeps(deps), id));
    });

  sessions
    .command('read')
    .description('derived reads of your own sessions at every order, each row stating its order and clusters: rates at order 1, relations between them at order 2, one labeled experiment at order 3, and what this store cannot read')
    .option('--family <name>', `only this family: ${FAMILIES.join(', ')}`)
    .option('--slice <axis=value>', 'only reads holding this value on this axis, such as model=claude-opus-5-5 (repeatable; all must match)', collect)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsRead(sessionDeps(deps), { family: text(options, 'family'), slices: list(options, 'slice') }));
    });

  sessions
    .command('books')
    .description('tokens, wall time, turns, errors, verify-after-edit rate, and the outcome signals (verify passed, stops, redos, commits, and commit survival) per prompt class, model, harness, or pull; with --by package, the public-package counts a field report prints, exclusions applied')
    .option('--by <key>', 'class, model, harness, pull, or package (default class)', (value: string): BooksBy | 'package' => {
      if (value !== 'class' && value !== 'model' && value !== 'harness' && value !== 'pull' && value !== 'package') throw new InvalidArgumentError('it must be class, model, harness, pull, or package.');
      return value;
    })
    .option('--since <days>', 'only the last N days', positiveInteger)
    .option('--repo <root>', "count only this repository's sessions (worktrees and subfolders included); without it, the whole store")
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const picked = text(options, 'by');
      const by: BooksBy | 'package' = picked === 'model' || picked === 'harness' || picked === 'pull' || picked === 'package' ? picked : 'class';
      const termsFile = deps.sessions === undefined ? undefined : exclusionPaths(deps.sessions.projectsRoot, deps.env).terms;
      emit(deps, flag(options, 'json'), await sessionsBooks(sessionDeps(deps), { by, sinceDays: count(options, 'since'), repo: text(options, 'repo'), termsFile }));
    });

  sessions
    .command('measure')
    .description('the G1 signals for the last N sessions and the N before, and the pipeline step counters over the whole log')
    .option('--last <n>', 'sessions per window (default 50)', positiveInteger)
    .option('--since <iso>', 'pin the current window to the first N sessions started at or after this ISO time (the prior window is the N before it); without it the window is the last N and moves with every deposit', isoTime)
    .option('--repo <root>', "count only this repository's sessions (worktrees and subfolders included); without it, the whole store")
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsMeasure(sessionDeps(deps), { last: count(options, 'last') ?? 50, since: text(options, 'since'), repo: text(options, 'repo') }));
    });

  sessions
    .command('verify')
    .description('run the consistency invariants on the stored skeletons and capture records, report every session on its own, and audit each against its raw file (Merkle root, counts)')
    .option('--session <id>', 'one session instead of all')
    .option('--strict', 'exit non-zero (4) when any invariant has exceptions, a step is stuck, or the raw audit finds a root mismatch or counts that do not bind; by default FAIL lines still exit 0')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const { failed, report, ...outcome } = await sessionsVerify(sessionDeps(deps), { session: text(options, 'session') });
      const json = flag(options, 'json');
      if (flag(options, 'strict') && failed.length > 0) {
        // One document under --json: the failure carries the invariants, so the success document is not printed first.
        if (!json) emit(deps, json, outcome);
        throw new CliError(`${String(failed.length)} ${failed.length === 1 ? 'check' : 'checks'} failed: ${failed.join('; ')}`, ExitCode.INVALID, 'verify', undefined, json ? report : undefined);
      }
      emit(deps, json, outcome);
    });

  sessions
    .command('exclusions')
    .description('scan the local store and transcripts under the exclusion rule, write the excluded sessions to a local file, and print counts only (the term file is named by OARS_EXCLUSION_TERMS)')
    .option('--out <file>', 'where to write the excluded sessions (default: session-commons/exclusion-list.jsonl beside the claude projects folder)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
      emit(deps, flag(options, 'json'), await sessionsExclusions(deps.sessions, exclusionPaths(deps.sessions.projectsRoot, deps.env, text(options, 'out'))));
    });

  const gold = sessions.command('gold').description('a blind, human-judged sample of prompts, and every signal scored against those judgments');

  gold
    .command('sample')
    .description('write about 200 prompts in batches to judge blind, across prompt classes and models, with the signals in a hidden sidecar; it never overwrites a file')
    .option('--size <n>', 'prompts to draw (default 200)', positiveInteger)
    .option('--batch <n>', 'prompts per batch (default 50)', positiveInteger)
    .option('--seed <text>', "the draw's seed (default today's date)")
    .option('--exclude-term <text>', 'also leave out any session that mentions this, in any case, beyond the local term file (OARS_EXCLUSION_TERMS) that always applies (repeatable)', collect)
    .option('--out-dir <folder>', 'where to write (default <claude config>/session-commons/review)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
      emit(
        deps,
        flag(options, 'json'),
        await sessionsGoldSample(sessionDeps(deps), {
          termsFile: exclusionPaths(deps.sessions.projectsRoot, deps.env).terms,
          size: count(options, 'size') ?? 200,
          batch: count(options, 'batch') ?? 50,
          seed: text(options, 'seed'),
          excludeTerms: list(options, 'excludeTerm'),
          outDir: text(options, 'outDir'),
        }),
      );
    });

  gold
    .command('score')
    .description('per signal and per model, the AUROC with its 95% interval and the base rate, from whatever is judged so far')
    .argument('<file>', 'the gold file')
    .action(async (file: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsGoldScore({ file }));
    });

  gold
    .command('arms')
    .description('fill the hidden sidecar: the closing claim, its Confidence line, and fresh single-turn readers on your Claude subscription, with fixed, hashed wording. It resumes, and never touches the gold file')
    .argument('<file>', 'the gold file')
    .action(async (file: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsGoldArms(sessionDeps(deps), { file }));
    });

  const hook = sessions.command('hook').description('install the recall hooks into a Claude Code settings file, and remove the scheduled task earlier versions registered');
  const scopeOption = (value: string): Scope => {
    if (value !== 'user' && value !== 'project' && value !== 'file') throw new InvalidArgumentError('it must be user, project, or file.');
    return value;
  };
  const scopeOf = (options: OptionValues): Scope | undefined => {
    const value = text(options, 'scope');
    return value === 'user' || value === 'project' || value === 'file' ? value : undefined;
  };

  const harnessOption = (value: string): 'codex' => {
    if (value !== 'codex') throw new InvalidArgumentError('it must be codex (Claude Code is the default and needs no flag).');
    return value;
  };
  const harnessOf = (options: OptionValues): 'codex' | undefined => (text(options, 'harness') === 'codex' ? 'codex' : undefined);

  hook
    .command('install')
    .description('merge the SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, and SessionEnd hooks into a settings file (existing hooks are kept), raise cleanupPeriodDays to at least 365, and, on Windows, remove the nightly task an earlier version registered (oars installs no scheduler: a due sweep and send, at most about hourly, starts from the session-end hook and from any oars command; telemetry goes only while it is on, and pool batches only after you accept a pool covenant)')
    .option('--scope <scope>', 'user (~/.claude/settings.json; the default), project (./.claude/settings.json), or file (needs --file; implied by --file)', scopeOption)
    .option('--file <path>', 'the settings file for --scope file')
    .option('--harness <harness>', 'codex: install the opt-in Codex recording hook in hooks.json in the Codex home instead (Codex asks you to trust it before it runs; it records tool and token rows locally while codex is allowed)', harnessOption)
    .option('--keep-retention', 'leave cleanupPeriodDays as it is (the harness deletes raw transcripts older than it)')
    .option('--machine', 'write the Stop and SessionEnd entries of a machine (a cloud VM, a VPS, or a runner): they run oars-hook, which builds the batch of its session at each Stop only where OARS_HOST_CLASS names a class other than local; --scope project (committed) or --scope user')
    .option('--env <name=value>', 'with --machine --scope user: one variable of the enrollment block for the env block of that file (OARS_HOST_CLASS is required; repeat the flag; OARS_EXCLUSION_TERMS_INLINE: one term per line; a comma is part of the term); the file is then made owner-only', (value: string, before: string[] | undefined): string[] => [...(before ?? []), value])
    .option('--terms-file <path>', 'with --machine --scope user: write the OARS_EXCLUSION_TERMS_INLINE terms to this owner-only file and name it in OARS_EXCLUSION_TERMS, so the settings file holds no term')
    .option('--schedule <mode>', 'off: no background sweep or pool send from the session-end hook or from commands (telemetry has its own switch: oars telemetry off), and remove the task an earlier version registered; on: clear that choice; nightly is refused, because sends now ride the hook and commands', (value: string) => {
      if (value !== 'nightly' && value !== 'off' && value !== 'on') throw new InvalidArgumentError('it must be off or on (nightly is no longer registered).');
      return value;
    })
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const schedule = text(options, 'schedule');
      emit(
        deps,
        flag(options, 'json'),
        await sessionsHookInstall(sessionDeps(deps), {
          scope: scopeOf(options),
          file: text(options, 'file'),
          keepRetention: flag(options, 'keepRetention'),
          schedule: schedule === 'nightly' || schedule === 'off' || schedule === 'on' ? schedule : undefined,
          harness: harnessOf(options),
          machine: flag(options, 'machine'),
          env: list(options, 'env'),
          termsFile: text(options, 'termsFile'),
        }),
      );
    });

  hook
    .command('uninstall')
    .description('remove only the hooks `install` wrote from a settings file (cleanupPeriodDays stays; it also removes the task an earlier version registered)')
    .option('--scope <scope>', 'user (the default), project, or file (needs --file; implied by --file)', scopeOption)
    .option('--file <path>', 'the settings file for --scope file')
    .option('--harness <harness>', 'codex: remove only the Codex recording hook from hooks.json in the Codex home', harnessOption)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsHookUninstall(sessionDeps(deps), { scope: scopeOf(options), file: text(options, 'file'), harness: harnessOf(options) }));
    });

  hook
    .command('status')
    .description('what is installed in the user and project settings (and --file), and whether a task an earlier version registered is still there')
    .option('--file <path>', 'one more settings file to report')
    .option('--harness <harness>', 'codex: report the Codex recording hook in hooks.json in the Codex home instead', harnessOption)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsHookStatus(sessionDeps(deps), { file: text(options, 'file'), harness: harnessOf(options) }));
    });

  const gate = program.command('gate').description('record the install, fetch-and-run, MCP, and skill picks your agents make, live through a hook or from logs already on disk, without judging them');

  gate
    .command('replay')
    .description('find the crossings in your session logs and write them to crossings.jsonl in the sessions store; reads nothing outside the allowlist, and asks the package manager what the registry holds unless --no-registry-state')
    .option('--allow <folder>', 'a project folder to read, as for `oars sessions deposit` (repeatable); default: the allowlist a deposit saved, else every folder', collect)
    .option('--no-registry-state', 'do not ask the package manager what the registry holds for each package named (npm view, pip index versions; asked by default, as the live hook does, and the manager keeps its own cache)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await gateReplay(sessionDeps(deps), { allow: list(options, 'allow'), ...(flag(options, 'registryState') ? { registry: managerReader() } : {}) }));
    });

  gate
    .command('hook')
    .description('the PreToolUse hook: reads the tool call on stdin, records any crossing in crossings.jsonl, and prints nothing unless the gate policy says to: a note as context, or a deny labeled with the fact for a name the registry does not hold; it never allows or changes a call (bin.js answers this command itself, before the rest of the CLI loads)')
    .action(async () => {
      const runtime = sessionDeps(deps).sessions;
      // No store means no file: an empty store folder would put crossings.jsonl in the working folder.
      if (runtime === undefined) return;
      let stdin = '';
      for await (const chunk of runtime.stdin) stdin += String(chunk);
      const output = await gateHook(stdin, { storeDir: runtime.storeDir, now: deps.now, clock: () => performance.now(), deadlineMs: DEADLINE_MS });
      if (output !== '') deps.io.stdout(output);
    });

  gate
    .command('install')
    .description('wire the gate hook into Claude Code at user scope (PreToolUse for Bash, PowerShell, Skill, and MCP tools); rerunning changes nothing, and every other setting and hook is kept')
    .action(async (_options: OptionValues, command: Command) => {
      emit(deps, flag(command.optsWithGlobals(), 'json'), await gateInstall(sessionDeps(deps)));
    });

  gate
    .command('uninstall')
    .description('remove only the gate hook `install` wrote from the user settings; crossings.jsonl stays')
    .action(async (_options: OptionValues, command: Command) => {
      emit(deps, flag(command.optsWithGlobals(), 'json'), await gateUninstall(sessionDeps(deps)));
    });

  gate
    .command('policy')
    .description('print the gate policy in force: per class warn, block, or off, the day count for a young name, and the holdback share; read from gate-policy.json in the sessions store, whose absence or damage means the defaults')
    .action(async (_options: OptionValues, command: Command) => {
      emit(deps, flag(command.optsWithGlobals(), 'json'), await gatePolicy(sessionDeps(deps)));
    });

  gate
    .command('report')
    .description('count the crossings in crossings.jsonl, by who recorded them, and say what replay cannot see')
    .action(async (_options: OptionValues, command: Command) => {
      emit(deps, flag(command.optsWithGlobals(), 'json'), await gateReport(sessionDeps(deps)));
    });

  const pool = program.command('pool').description('sign in to a pool server, deposit session skeletons (a closed list of fields, each value redacted first) and, after a yes to the raw prompt, redacted raw copies, and fetch signed reads; local capture, recall, and reads need none of it');
  const serverOption = '--server <url>';
  const serverHelp = 'the pool server, https or plain http to localhost (default: OARS_POOL_URL, else https://pool.manyoars.com)';

  pool
    .command('logout')
    .description('revoke the credential held for this pool and remove it here; if the pool cannot be reached the local entry is still removed')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolLogout(deps, { server: text(options, 'server') }));
    });

  pool
    .command('login')
    .description('sign in by GitHub or Google device flow, run here against the provider; prints each request before sending it, and the pool keeps a pseudonym; no harness token is read')
    .requiredOption('--provider <name>', 'github or google')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolLogin(deps, { server: text(options, 'server'), provider: text(options, 'provider') }));
    });

  pool
    .command('enroll')
    .description('enroll a machine: print the whole configuration a cloud VM needs (host class, launcher, a new machine id, the repositories, two salts derived from this machine\'s, and your exclusion terms) after checking that each repository is private (GH_TOKEN or GITHUB_TOKEN lets the check see a private one). With --hold-only that is all, and no pool credential is used; without it the pool also issues a one-time enrollment token for the machine, which needs oars pool login')
    .option('--hold-only', 'hold in the session\'s own repository and send nothing to the pool: no login, no token')
    .option('--host-class <class>', 'vps, cloud, ci, or hosted')
    .option('--launcher <launcher>', 'interactive, orchestrated, or scheduled')
    .option('--allow-repos <repos>', 'the repositories the machine may hold, as owner/name; repeat the flag or separate them with commas', collect)
    .option('--name <label>', 'without --hold-only: the label the pool lists this machine by (letters, digits, spaces, dots, underscores, and hyphens; 64 at most)')
    .option('--days <n>', 'without --hold-only: how many days the machine\'s key lives from its activation, 1 to 365 (default 90)')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const token = deps.env.GH_TOKEN ?? deps.env.GITHUB_TOKEN;
      emit(deps, flag(options, 'json'), await poolEnroll(deps, { holdOnly: flag(options, 'holdOnly'), hostClass: text(options, 'hostClass'), launcher: text(options, 'launcher'), allowRepos: list(options, 'allowRepos'), name: text(options, 'name'), days: text(options, 'days'), server: text(options, 'server') }, githubVisibility(fetch, token)));
    });

  const machines = pool
    .command('machines')
    .description('list the machines enrolled with the pool: label, id, host class, launcher, state, last deposit day, and expiry; needs oars pool login')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolMachines(deps, { server: text(options, 'server') }));
    });
  machines
    .command('revoke')
    .argument('<id>', 'the machine\'s id, as oars pool machines lists it')
    .description('revoke one machine: its key is refused from its next request')
    .option(serverOption, serverHelp)
    .action(async (id: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolMachineRevoke(deps, id, { server: text(options, 'server') }));
    });

  pool
    .command('hold')
    .description('the trusted machine\'s side of the holding route')
    .command('pull')
    .description('on the trusted machine, read the oars-hold/* branch tips of every enrolled machine\'s private repositories (each repository\'s visibility is checked again on every run) and admit each batch that passes every gate to the outbox; a branch that does not is reported and left where it is. Uses this machine\'s own git credential and GH_TOKEN or GITHUB_TOKEN for the visibility check')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const token = deps.env.GH_TOKEN ?? deps.env.GITHUB_TOKEN;
      const ports = { visibility: githubVisibility(fetch, token), git: runGit, net: runNetGit, remoteOf: (repo: string) => `https://github.com/${repo}.git` };
      emit(deps, flag(options, 'json'), await holdPull(deps, { server: text(options, 'server') }, ports));
    });

  pool
    .command('deposit')
    .description('write a batch to the outbox for each session that passes the folder allowlist and the exclusion check, and stop: no session data is sent, and only counts print. --send <hash> sends one batch that oars pool outbox printed and that is unchanged, once this account has accepted the pool covenant')
    .option('--accept-covenant <version>', 'name the covenant version you expect, with --send: on a terminal the screen is shown and you type its phrase yourself, and off a terminal this is refused')
    .option('--in-eu-eea-uk <yes|no>', 'answer "Are you in the EU, the EEA, or the UK?" when you accept, with --send; without it a person is asked, with or without --accept-covenant. While the pool is closed to those regions, yes is refused')
    .option('--send <hash>', 'the SHA-256 of a batch that oars pool outbox printed')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolDeposit(deps, { server: text(options, 'server'), acceptCovenant: text(options, 'acceptCovenant'), inEuEeaUk: text(options, 'inEuEeaUk'), send: text(options, 'send') }));
    });

  pool
    .command('raw')
    .description('the raw prompt: whether a redacted copy of each full transcript may leave besides its skeleton (--consent yes|no), and what one folder may send (--folder <folder> --mode all|skeleton|off); with no option, shows the prompt and your answer')
    .option('--consent <answer>', 'yes or no; a no, or no answer, sends skeletons only')
    .option('--folder <entry>', 'a folder, folder prefix, or glob, as --allow takes it')
    .option('--mode <mode>', 'all, skeleton, or off for that folder: on by default after you accept; skeleton sends no raw; off sends nothing from that folder to the pool from now on')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolRaw(deps, { consent: text(options, 'consent'), folder: text(options, 'folder'), mode: text(options, 'mode') }));
    });

  pool
    .command('coverage')
    .description('state whom your deposits cover, kept on this machine and never looked up: --org-size solo, 2-10, 11-100, 101-1000, over-1000, or unknown; --repo-visibility public, private, or unknown. With no flag it prints what is set')
    .option('--org-size <band>', 'how many people your organization has')
    .option('--repo-visibility <visibility>', 'whether your repositories are public or private')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolCoverage(deps, { orgSize: text(options, 'orgSize'), repoVisibility: text(options, 'repoVisibility') }));
    });

  pool
    .command('outbox')
    .description('print every batch exactly as it would be sent, request line and headers included, with the credential as its size; prints each batch SHA-256 and records that it was shown')
    .option('--explain', 'print each field of a batch with the rule that admits its values')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolOutbox(deps, { server: text(options, 'server'), explain: flag(options, 'explain') }));
    });

  pool
    .command('prove')
    .description('prove you control your pool account with your sign-in, and print the account and the time the pool stored, to send to the operator who asked for proof before acting on your request (GDPR Article 12(6)); for a closed account, run login instead')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolProve(deps, { server: text(options, 'server') }));
    });

  pool
    .command('export')
    .description('save a copy of what the pool holds about your account to a folder, as JSON, one file a page, and write nothing to the pool; with --raw also save your own raw transcripts that still stand (GDPR Articles 15 and 20)')
    .requiredOption('--out <folder>', 'the folder to save the export in; its files are owner-only, and a rerun overwrites the same ones')
    .option('--raw', 'also fetch each raw transcript you deposited that has not been erased, into <folder>/raw')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolExport(deps, { server: text(options, 'server'), out: text(options, 'out') ?? '', raw: flag(options, 'raw') }));
    });

  pool
    .command('fetch')
    .description('fetch the signed bundle for one harness version, verify it against the key pinned at login, and keep it locally')
    .option('--harness <name>', 'the harness whose bundle to fetch (default: the one your local store holds the most sessions of, claude-code when none leads)')
    .requiredOption('--harness-version <version>', 'the public harness version whose bundle to fetch, or unknown for a session that recorded none (Cursor, Gemini, Grok Build, Pi, or a VS Code Copilot Chat session whose requests name no agent version; there is no bundle for otel)')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolFetch(deps, { server: text(options, 'server'), harness: text(options, 'harness'), harnessVersion: text(options, 'harnessVersion') ?? '' }));
    });

  const telemetry = program.command('telemetry').description('what oars records about its own use, on this machine (docs/telemetry.md): status, on, off, show, and report');
  const telemetryJson = (command: Command): boolean => flag(command.optsWithGlobals(), 'json');

  telemetry
    .command('status')
    .description('whether telemetry is on, which switch decided it, whether the notice was shown, and the size of the spool')
    .action((_options: OptionValues, command: Command) => {
      emit(deps, telemetryJson(command), telemetryStatus(deps));
    });

  telemetry
    .command('on')
    .description('turn telemetry on, and print what it records (OARS_TELEMETRY=0 and DO_NOT_TRACK=1 still win)')
    .action((_options: OptionValues, command: Command) => {
      emit(deps, telemetryJson(command), telemetryOn(deps));
    });

  telemetry
    .command('off')
    .description('turn telemetry off: nothing more is recorded or sent')
    .action((_options: OptionValues, command: Command) => {
      emit(deps, telemetryJson(command), telemetryOff(deps));
    });

  telemetry
    .command('show')
    .description('print the spool exactly as stored: every event telemetry has kept, oldest first')
    .action((_options: OptionValues, command: Command) => {
      emit(deps, telemetryJson(command), telemetryShow(deps));
    });

  telemetry
    .command('report')
    .description('your own hook latency, hit rates, and store health over the last 7 and 30 days, from the spool, beside the fleet\'s when OARS_POOL_URL names a pool server that answers')
    .action(async (_options: OptionValues, command: Command) => {
      emit(deps, telemetryJson(command), await telemetryReport(deps));
    });

  return program;
};

const asCliError = (error: unknown): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof CommanderError) return new CliError(error.message.replace(/^error: /, ''), ExitCode.USAGE, 'usage');
  return new CliError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, ExitCode.UNEXPECTED, 'unexpected');
};

const execute = async (argv: string[], deps: RunDeps, observed: Observed): Promise<ExitCode> => {
  try {
    await buildProgram(deps, observed).parseAsync(argv, { from: 'user' });
    return ExitCode.OK;
  } catch (error) {
    // --help and --version end the parse through exitOverride with exit code 0; commander has already printed them.
    if (error instanceof CommanderError && error.exitCode === 0) return ExitCode.OK;
    // A failure the program did not mean (not a CliError, not commander's own): its class and a hash of its stack are recorded, then it is handled as before.
    if (!(error instanceof CliError) && !(error instanceof CommanderError)) recordCrash(deps, error);
    const failure = asCliError(error);
    // Commander wrote its own usage message to stderr; a CliError is ours to print.
    if (!(error instanceof CommanderError) || argv.includes('--json')) printFailure(deps, argv.includes('--json'), failure);
    return failure.exitCode;
  }
};

/** `sessions hook uninstall` is the first step of removing the store, so it must not start a sweep that would recreate what the person is about to delete. */
const isHookUninstall = (observed: Observed): boolean => observed.path.join(' ') === 'sessions hook uninstall';
/** `sessions try` promises no network call and no read of the real store, and the sender does both. */
const isSessionsTry = (observed: Observed): boolean => observed.path.join(' ') === 'sessions try';

/** The weekly card line (`sessions/card-line.ts`): stderr only, never an error, never a change to the exit code. */
const weeklyLine = (argv: string[], deps: RunDeps, observed: Observed): Promise<CardLineArm> =>
  deps.sessions === undefined
    ? Promise.resolve('not_due')
    : cardLine({ storeDir: deps.sessions.storeDir, telemetryDir: deps.telemetry?.dir, now: deps.now(), tty: deps.sessions.stderr?.isTTY === true, argv, path: observed.path, flags: observed.flags, stderr: deps.io.stderr });

/** Runs one invocation (`argv` without the node and script entries) and returns the exit code. Telemetry records it afterward and cannot change it. */
export const run = async (argv: string[], deps: RunDeps): Promise<ExitCode> => {
  const observed: Observed = { path: [], flags: [] };
  const startedAt = deps.now();
  const exit = await execute(argv, deps, observed);
  observed.cardLine = await weeklyLine(argv, deps, observed);
  finishTelemetry(deps, argv, observed, startedAt, exit);
  // Never from a gate hook (it runs before every tool call) or from `hook uninstall`; it cannot change the exit code or what the command printed.
  if (deps.catchUp !== undefined && !isHook(argv, observed) && !isHookUninstall(observed) && !isSessionsTry(observed)) await Promise.resolve().then(deps.catchUp).catch(() => undefined);
  return exit;
};
