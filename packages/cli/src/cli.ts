import { Command, CommanderError, type OptionValues } from 'commander';
import { resolveApiUrl } from './api.js';
import { login } from './commands/login.js';
import { logout } from './commands/logout.js';
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

const emit = (deps: RunDeps, json: boolean, outcome: Outcome): void => {
  deps.io.stdout(`${json ? JSON.stringify(outcome.document) : outcome.text}\n`);
};

/** `--json` prints `{ok: false, step, problem}` on stdout; otherwise the problem's title, detail and URL go to stderr. */
const printFailure = (deps: RunDeps, json: boolean, error: CliError): void => {
  if (json) {
    deps.io.stdout(`${JSON.stringify({ ok: false, step: error.step, problem: error.problem })}\n`);
    return;
  }
  const { title, detail, actionUrl } = error.problem;
  deps.io.stderr(`${[title ?? error.message, detail, actionUrl].filter((line) => line !== undefined && line !== '').join('\n')}\n`);
};

const buildProgram = (deps: RunDeps): Command => {
  const program = new Command('oars')
    .description('Deploy an agent on Many Oars and set its prices')
    .version(deps.version)
    .exitOverride()
    .configureOutput({ writeOut: deps.io.stdout, writeErr: deps.io.stderr })
    .option('--json', 'print one JSON document on stdout instead of text')
    .option('--api-url <url>', 'the platform API (default: OARS_API_URL, else https://api.manyoars.com)');

  program
    .command('login')
    .description('sign in with your browser (RFC 8628 device flow)')
    .option('--no-browser', 'print the link and code without opening a browser')
    .option('--issuer-url <url>', 'the Keycloak realm URL (default: OARS_ISSUER_URL)')
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
    await buildProgram(deps).parseAsync(argv, { from: 'user' });
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
