import { randomUUID } from 'node:crypto';
import { Command, CommanderError, InvalidArgumentError, type OptionValues } from 'commander';
import { resolveApiUrl } from './api.js';
import { deploy } from './commands/deploy.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { purchasingCap, purchasingCard, purchasingList, type BillingMode } from './commands/purchasing.js';
import { status } from './commands/status.js';
import { templates } from './commands/templates.js';
import { testCharge } from './commands/test-charge.js';
import type { CredentialStore } from './credentials.js';
import { CliError, ExitCode } from './errors.js';
import { requirePurchasingOpen } from './issuer.js';
import type { JournalStore } from './journal.js';
import type { BooksBy, RecallQuery } from './sessions/query.js';
import { closedQueryOf, formsRefusal, RECALL_FAMILIES } from './sessions/recall-reads.js';
import { FAMILIES } from './sessions/read.js';
import { sessionsBooks, sessionsContext, sessionsDeposit, sessionsGoldArms, sessionsGoldSample, sessionsGoldScore, sessionsHookInstall, sessionsHookStatus, sessionsHookUninstall, sessionsMcp, sessionsLineage, sessionsMeasure, sessionsRead, sessionsRecall, sessionsRecallCounts, sessionsVerify, type SessionsDeps } from './sessions/command.js';
import { exclusionPaths, sessionsExclusions } from './sessions/exclusion.js';
import { poolDeposit, poolLogin, poolPull } from './sessions/pool-command.js';
import type { InstallRuntime, Scope } from './sessions/install.js';
import type { SessionsRuntime } from './sessions/store.js';

/** Everything the CLI takes from its process, so the tests can stand in for each. */
export interface RunDeps {
  env: NodeJS.ProcessEnv;
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  store: CredentialStore;
  /** Where `deploy` keeps its progress between a failed run and the rerun. */
  journal: JournalStore;
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

const billingMode = (value: string): BillingMode => {
  const mode = value.toUpperCase();
  if (mode !== 'TEST' && mode !== 'LIVE') throw new InvalidArgumentError('it must be TEST or LIVE.');
  return mode;
};

/** Whole cents, as the platform parses them; the string goes on the wire as typed. */
const usdAmount = (value: string): string => {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new InvalidArgumentError('it must be a dollar amount in whole cents, such as 100 or 12.50 (0 turns purchasing off).');
  return value;
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

/** The last line of an exit 6: the one thing a person must do, by link when the platform sent one, then to rerun. Stripe onboarding is the step most runs wait on. */
const needsYouLine = (code: string | undefined, actionUrl: string | undefined): string => {
  const stripe = code === 'ACCOUNT_NOT_READY';
  if (actionUrl !== undefined && actionUrl !== '') {
    return `Needs you: ${stripe ? 'finish Stripe onboarding at' : 'open'} ${actionUrl}, then rerun this command.`;
  }
  return stripe
    ? 'Needs you: finish Stripe onboarding (Account, then Payout account, in the Many Oars web app), then rerun this command.'
    : 'Needs you: a step only a person can do. Do it in the Many Oars web app, then rerun this command.';
};

/**
 * `--json` prints `{ok: false, step, problem}` on stdout, plus `workloadId`, `sdkKey` and `rerun` after a deploy that stopped;
 * otherwise the problem's title, detail, and URL go to stderr (on an exit 6 the URL moves into a last "Needs you:" line),
 * then the rerun line, and the one-time SDK key goes to stdout.
 */
const printFailure = (deps: RunDeps, json: boolean, error: CliError): void => {
  const { partial } = error;
  if (json) {
    deps.io.stdout(`${JSON.stringify({ ok: false, step: error.step, problem: error.problem, ...partial, ...error.details })}\n`);
    return;
  }
  const { title, detail, actionUrl } = error.problem;
  const resume = partial === undefined ? [] : [`Workload ${partial.workloadId} is registered; the deploy stopped at ${error.step}.`, `Rerun to resume: ${partial.rerun}`];
  const needsYou = error.exitCode === ExitCode.HUMAN ? [needsYouLine(error.problem.code, actionUrl)] : [];
  deps.io.stderr(`${[title ?? error.message, detail, ...(needsYou.length === 0 ? [actionUrl] : []), ...resume, ...needsYou].filter((line) => line !== undefined && line !== '').join('\n')}\n`);
  if (partial?.sdkKey !== undefined) deps.io.stdout(`SDK key (shown once; save it now): ${partial.sdkKey}\n`);
};

const sessionDeps = (deps: RunDeps): SessionsDeps => ({ sessions: deps.sessions, install: deps.install, now: deps.now });

const buildProgram = (deps: RunDeps, argv: string[]): Command => {
  const program = new Command('oars')
    .description('Deploy an agent on Many Oars and set its prices')
    .version(deps.version)
    .exitOverride()
    .configureOutput({ writeOut: deps.io.stdout, writeErr: deps.io.stderr })
    .option('--json', 'print one JSON document on stdout instead of text')
    .option('--api-url <url>', 'the platform API (default: OARS_API_URL, else https://api.manyoars.com)')
    .option('--idempotency-key <key>', "the base of every step's idempotency key (default: a fresh UUID); rerun a failed command with the same key to resume");

  program
    .command('login')
    .description('sign in with your browser (RFC 8628 device flow)')
    .option('--no-browser', 'print the link and code without opening a browser')
    .option('--issuer-url <url>', 'the Keycloak realm URL (default: OARS_ISSUER_URL, else Many Oars once it has launched)')
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

  program
    .command('templates')
    .description('list the starter templates `oars deploy --template` takes')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await templates(deps, { apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')) }));
    });

  program
    .command('deploy')
    .description('register a workload, create its prices and deploy it; stops at the first failed step (exit 9)')
    .option('--template <id>', 'a starter template from the catalog (see: oars templates)')
    .option('--image <ref>', 'an image pinned by digest (name@sha256:...)')
    .option('--manifest <file>', 'a JSON workload manifest')
    .option('--name <name>', 'the workload name (--image)')
    .option('--port <n>', 'the service port (--image; default 8080)', positiveInteger)
    .option('--public', 'expose the service publicly (--image)')
    .option('--cpu-millicores <n>', 'CPU in millicores (--image; default 250)', positiveInteger)
    .option('--memory-mib <n>', 'memory in MiB (--image; default 256)', positiveInteger)
    .option('--always-on', 'keep the public service running instead of idling')
    .option('--price <ref>', 'a starter price to create instead of all of them (--template; repeatable)', collect)
    .option('--no-prices', "create none of the template's starter prices (--template)")
    .option('--price-file <file>', 'a JSON array of prices to create (--image, --manifest)')
    .option('--secret <NAME=value>', 'a secret for the workload (repeatable); prefer --secret-from-env', collect)
    .option('--secret-from-env <NAME>', 'a secret read from the environment variable NAME (repeatable)', collect)
    .option('--no-start', 'register and price the workload without deploying it')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const outcome = await deploy(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        argv,
        start: options.start !== false,
        idempotencyKey: text(options, 'idempotencyKey'),
        template: text(options, 'template'),
        image: text(options, 'image'),
        manifestFile: text(options, 'manifest'),
        name: text(options, 'name'),
        port: count(options, 'port'),
        public: flag(options, 'public') ? true : undefined,
        cpuMillicores: count(options, 'cpuMillicores'),
        memoryMib: count(options, 'memoryMib'),
        alwaysOn: flag(options, 'alwaysOn') ? true : undefined,
        prices: list(options, 'price'),
        noPrices: options.prices === false,
        priceFile: text(options, 'priceFile'),
        secrets: list(options, 'secret'),
        secretsFromEnv: list(options, 'secretFromEnv'),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  program
    .command('status')
    .description('show a workload and its billing mode')
    .argument('<workloadId>', 'the workload id')
    .action(async (workloadId: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await status(deps, { apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')), workloadId }));
    });

  program
    .command('test-charge')
    .description("make a TEST-mode charge against one of a workload's prices")
    .argument('<workloadId>', 'the workload id')
    .option('--price <ref>', "the price to charge (default: the workload's only active price)")
    .action(async (workloadId: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const outcome = await testCharge(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        workloadId,
        priceRef: text(options, 'price'),
        idempotencyKey: text(options, 'idempotencyKey') ?? randomUUID(),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  // Hidden and refused until t465 opens paid agents (issuer.ts requirePurchasingOpen); the code stays for it.
  const purchasing = program
    .command('purchasing', { hidden: true })
    .description("set up an agent's purchasing: the card, the monthly cap, and what it bought")
    .hook('preAction', () => {
      requirePurchasingOpen(deps);
    })
    // A command with subcommands and no action prints help before preAction runs; this makes bare `purchasing` hit the gate first.
    .action(() => {
      purchasing.help({ error: true });
    });

  purchasing
    .command('card')
    .description('start saving the purchasing card; prints the page a person saves it on (exit 6)')
    .requiredOption('--mode <mode>', 'TEST or LIVE', billingMode)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const outcome = await purchasingCard(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        mode: billingMode(text(options, 'mode') ?? ''),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  purchasing
    .command('cap')
    .description("set an agent's monthly purchasing cap: a lower one applies at once; a higher one prints the page a person approves it on (exit 6)")
    .argument('<workloadId>', "the buying agent's workload id")
    .requiredOption('--mode <mode>', 'TEST or LIVE', billingMode)
    .requiredOption('--usd <amount>', 'dollars a month, whole cents; 0 turns purchasing off', usdAmount)
    .action(async (workloadId: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const outcome = await purchasingCap(deps, {
        apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')),
        workloadId,
        mode: billingMode(text(options, 'mode') ?? ''),
        monthlyCapUsd: text(options, 'usd') ?? '',
        idempotencyKey: text(options, 'idempotencyKey') ?? randomUUID(),
      });
      emit(deps, flag(options, 'json'), outcome);
    });

  purchasing
    .command('list')
    .description('list what an agent has bought')
    .argument('<workloadId>', "the buying agent's workload id")
    .action(async (workloadId: string, _options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await purchasingList(deps, { apiUrl: resolveApiUrl(deps, text(options, 'apiUrl')), workloadId }));
    });

  const sessions = program.command('sessions').description("deposit and recall your own Claude Code session logs, locally (no model calls, no network, except `gold arms`, which asks your own Claude subscription)");

  sessions
    .command('deposit')
    .description('read session logs from the folders you name into the local observation log; idempotent. Subagent transcripts under each session (<project>/<session>/subagents/) are deposited with their parent, and each raw transcript is hard-linked into the oars archive beside the store')
    .option('--allow <folder>', 'a project folder to read: its path, or its name under ~/.claude/projects (repeatable); `cursor` names the Cursor store. A trailing slash names everything under a folder; * and ? are wildcards', collect)
    .option('--allow-file <list>', 'a file of --allow entries, one per line (# starts a comment); repeatable, combines with --allow', collect)
    .option('--redact-domain <domain>', 'an organization domain to mask in everything written (repeatable)', collect)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsDeposit(sessionDeps(deps), { allow: list(options, 'allow'), allowFiles: list(options, 'allowFile'), redactDomains: list(options, 'redactDomain') }));
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
    .option('--counts', 'print counts of recalls by mode, arm, and answer, with what followed, instead of answering (see --day)')
    .option('--day <yyyy-mm-dd>', 'with --counts: only this UTC day')
    .option('--mcp', 'serve one recall tool over MCP on stdio instead of answering once')
    .option('--context', "print the repository's top recurring errors as a short block for injection into a session (see --cwd, --harness, --top, --max-chars)")
    .option('--cwd <dir>', "with --context: the session's working directory (default: this one)")
    .option('--harness <version>', 'with --context: only errors seen under this Claude Code version')
    .option('--top <n>', 'with --context: how many signatures (default 5)', positiveInteger)
    .option('--max-chars <n>', "with --context: the block's length limit (default 1200)", positiveInteger)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
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
    .description('tokens, wall time, turns, errors, verify-after-edit rate, and the outcome signals (verify passed, stops, redos, commits, and commit survival) per prompt class, model, harness, or pull')
    .option('--by <key>', 'class, model, harness, or pull (default class)', (value: string): BooksBy => {
      if (value !== 'class' && value !== 'model' && value !== 'harness' && value !== 'pull') throw new InvalidArgumentError('it must be class, model, harness, or pull.');
      return value;
    })
    .option('--since <days>', 'only the last N days', positiveInteger)
    .option('--repo <root>', "count only this repository's sessions (worktrees and subfolders included); without it, the whole store")
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      const picked = text(options, 'by');
      const by: BooksBy = picked === 'model' || picked === 'harness' || picked === 'pull' ? picked : 'class';
      emit(deps, flag(options, 'json'), await sessionsBooks(sessionDeps(deps), { by, sinceDays: count(options, 'since'), repo: text(options, 'repo') }));
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
        throw new CliError(`${String(failed.length)} ${failed.length === 1 ? 'check' : 'checks'} failed: ${failed.join('; ')}`, ExitCode.INVALID, 'verify', undefined, undefined, json ? report : undefined);
      }
      emit(deps, json, outcome);
    });

  sessions
    .command('exclusions')
    .description('scan the local store and transcripts under the V15 rule, write the excluded sessions to a local file, and print counts only (the term file is named by OARS_EXCLUSION_TERMS)')
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
    .option('--exclude-term <text>', 'leave out any session that mentions this, in any case, in its transcript or a subagent transcript (repeatable)', collect)
    .option('--out-dir <folder>', 'where to write (default <claude config>/session-commons/review)')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(
        deps,
        flag(options, 'json'),
        await sessionsGoldSample(sessionDeps(deps), {
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

  const hook = sessions.command('hook').description('install the recall hooks into a Claude Code settings file, and the nightly deposit task');
  const scopeOption = (value: string): Scope => {
    if (value !== 'user' && value !== 'project' && value !== 'file') throw new InvalidArgumentError('it must be user, project, or file.');
    return value;
  };
  const scopeOf = (options: OptionValues): Scope | undefined => {
    const value = text(options, 'scope');
    return value === 'user' || value === 'project' || value === 'file' ? value : undefined;
  };

  hook
    .command('install')
    .description('merge the SessionStart, PostToolUseFailure, and SessionEnd hooks into a settings file (existing hooks are kept) and raise cleanupPeriodDays to at least 365')
    .option('--scope <scope>', 'user (~/.claude/settings.json), project (./.claude/settings.json), or file (needs --file; the default)', scopeOption)
    .option('--file <path>', 'the settings file for --scope file')
    .option('--keep-retention', 'leave cleanupPeriodDays as it is (the harness deletes raw transcripts older than it)')
    .option('--schedule <mode>', 'nightly: register a Windows task that runs the full deposit and the recurrence refresh daily; off: remove it', (value: string) => {
      if (value !== 'nightly' && value !== 'off') throw new InvalidArgumentError('it must be nightly or off.');
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
          schedule: schedule === 'nightly' || schedule === 'off' ? schedule : undefined,
        }),
      );
    });

  hook
    .command('uninstall')
    .description('remove only the hooks `install` wrote from a settings file (cleanupPeriodDays stays; `install --schedule off` removes the task)')
    .option('--scope <scope>', 'user, project, or file (needs --file; the default)', scopeOption)
    .option('--file <path>', 'the settings file for --scope file')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsHookUninstall(sessionDeps(deps), { scope: scopeOf(options), file: text(options, 'file') }));
    });

  hook
    .command('status')
    .description('what is installed in the user and project settings (and --file), and whether the nightly task is registered')
    .option('--file <path>', 'one more settings file to report')
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await sessionsHookStatus(sessionDeps(deps), { file: text(options, 'file') }));
    });

  const pool = program.command('pool').description('sign in to a pool server, deposit closed-vocabulary session skeletons, and pull signed reads; local capture, recall, and reads need none of it');
  const serverOption = '--server <url>';
  const serverHelp = 'the pool server, https or plain http to localhost (or OARS_POOL_URL; there is no default)';

  pool
    .command('login')
    .description('sign in by GitHub or Google device flow; the pool keeps a pseudonym, and no harness token is read')
    .requiredOption('--provider <name>', 'github or google')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolLogin(deps, { server: text(options, 'server'), provider: text(options, 'provider') }));
    });

  pool
    .command('deposit')
    .description('send every session that passes the V15 check as a closed-vocabulary skeleton, and print counts only')
    .option('--accept-covenant <version>', 'accept this version of the pool covenant before depositing')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolDeposit(deps, { server: text(options, 'server'), acceptCovenant: text(options, 'acceptCovenant') }));
    });

  pool
    .command('pull')
    .description('fetch one signed slice of the pool, verify it against the key pinned at login, and keep it locally')
    .option('--stack <name>', 'a language or framework, or all', 'all')
    .option(serverOption, serverHelp)
    .action(async (_options: OptionValues, command: Command) => {
      const options: OptionValues = command.optsWithGlobals();
      emit(deps, flag(options, 'json'), await poolPull(deps, { server: text(options, 'server'), stack: text(options, 'stack') ?? 'all' }));
    });

  return program;
};

const asCliError = (error: unknown): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof CommanderError) return new CliError(error.message.replace(/^error: /, ''), ExitCode.USAGE, 'usage');
  return new CliError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, ExitCode.UNEXPECTED, 'unexpected');
};

/** Runs one invocation (`argv` without the node and script entries) and returns the exit code. */
export const run = async (argv: string[], deps: RunDeps): Promise<ExitCode> => {
  try {
    await buildProgram(deps, argv).parseAsync(argv, { from: 'user' });
    return ExitCode.OK;
  } catch (error) {
    // --help and --version end the parse through exitOverride with exit code 0; commander has already printed them.
    if (error instanceof CommanderError && error.exitCode === 0) return ExitCode.OK;
    const failure = asCliError(error);
    // Commander wrote its own usage message to stderr; a CliError is ours to print.
    if (!(error instanceof CommanderError) || argv.includes('--json')) printFailure(deps, argv.includes('--json'), failure);
    return failure.exitCode;
  }
};
