import { randomUUID } from 'node:crypto';
import { Command, CommanderError, InvalidArgumentError, type OptionValues } from 'commander';
import { resolveApiUrl } from './api.js';
import { deploy } from './commands/deploy.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
import { status } from './commands/status.js';
import { templates } from './commands/templates.js';
import { testCharge } from './commands/test-charge.js';
import type { CredentialStore } from './credentials.js';
import { CliError, ExitCode } from './errors.js';
import type { JournalStore } from './journal.js';

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

const emit = (deps: RunDeps, json: boolean, outcome: Outcome): void => {
  deps.io.stdout(`${json ? JSON.stringify(outcome.document) : outcome.text}\n`);
};

/**
 * `--json` prints `{ok: false, step, problem}` on stdout, plus `workloadId`, `sdkKey` and `rerun` after a deploy that stopped;
 * otherwise the problem's title, detail and URL go to stderr, then the rerun line, and the one-time SDK key goes to stdout.
 */
const printFailure = (deps: RunDeps, json: boolean, error: CliError): void => {
  const { partial } = error;
  if (json) {
    deps.io.stdout(`${JSON.stringify({ ok: false, step: error.step, problem: error.problem, ...partial })}\n`);
    return;
  }
  const { title, detail, actionUrl } = error.problem;
  const resume = partial === undefined ? [] : [`Workload ${partial.workloadId} is registered; the deploy stopped at ${error.step}.`, `Rerun to resume: ${partial.rerun}`];
  deps.io.stderr(`${[title ?? error.message, detail, actionUrl, ...resume].filter((line) => line !== undefined && line !== '').join('\n')}\n`);
  if (partial?.sdkKey !== undefined) deps.io.stdout(`SDK key (shown once; save it now): ${partial.sdkKey}\n`);
};

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
