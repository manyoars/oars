// The deposit step (spec section 8), a later command than the run: `npm run deposit-fleet -w packages/fleet-runner -- <run book> --allowed-signers <file> --oars <path> [--identity <id>] [--fleet <file>] [--confirm]`.
// For each store folder the run wrote, it runs the public `oars pool deposit` (build), `oars pool outbox` (marks the batches shown), and `oars pool deposit --send-all` with that store's config root in the child's environment only, so the child reads that store, that sign-in file,
// and that exclusion-terms file, and no other. Without `--confirm` it prints what it would do and runs nothing. It never edits the signed run book: what it did goes to `<order id>.deposit-record.jsonl` beside it.
import { spawn } from 'node:child_process';
import { access, appendFile, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_IDLE_HOURS } from '../../cli/src/sessions/pool-wire.js';
import { signInsFile } from '../../cli/src/sessions/pool-replica.js';
import { objectAt, parseJson, stringAt } from './json.js';
import { type FleetManifest, parseFleet } from './manifest.js';
import { verifyRunBook } from './sign.js';
import { folderOf } from './stores.js';

const HOUR_MS = 60 * 60 * 1000;

interface Store {
  name: string;
  configRoot: string;
  /** The pool row ids the store's valid runs are expected to deposit under, in run order. */
  expected: string[];
}

interface Step {
  label: string;
  args: string[];
}

interface Parsed {
  orderId: string;
  manifestVersion: string;
  status: string;
  newestEnd: number;
  stores: Store[];
}

/** Reads only what the step needs from the run book; the file itself is never rewritten. */
const parseRunBook = (text: string, dir: string): Parsed => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const header = objectAt(parseJson(lines[0] ?? '', 'run book header'), 'run book header');
  const orderId = stringAt(header, 'orderId', 'run book header');
  const stores = new Map<string, Store>();
  let newestEnd = Number.NEGATIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const entry = objectAt(parseJson(line, 'run line'), 'run line');
    newestEnd = Math.max(newestEnd, Date.parse(stringAt(entry, 'end', 'run line')));
    const id = entry.poolSessionId;
    if (entry.void !== null || typeof id !== 'string') continue;
    const side = entry.side;
    const name = folderOf(typeof side === 'string' ? side : null, stringAt(entry, 'arm', 'run line'));
    const store = stores.get(name) ?? { name, configRoot: join(dir, `${orderId}.stores`, name), expected: [] };
    stores.set(name, store);
    store.expected.push(id);
  }
  return { orderId, manifestVersion: stringAt(header, 'manifestVersion', 'run book header'), status: typeof header.status === 'string' ? header.status : 'missing', newestEnd, stores: [...stores.values()] };
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The variable that names the config folder on this platform, as the CLI reads it (`credentials.ts` `defaultConfigDir`). */
const CONFIG_VARIABLE = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';

/** The child's environment: the parent's, with only the config variables pointed at the store's root. The parent's own `process.env` is never written. */
const childEnv = (configRoot: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, [CONFIG_VARIABLE]: configRoot, CLAUDE_CONFIG_DIR: join(configRoot, 'claude') };
  // The exclusion-terms file this store is checked for is the default one under CLAUDE_CONFIG_DIR; a variable that names another would send under different terms.
  Reflect.deleteProperty(env, 'OARS_EXCLUSION_TERMS');
  // A machine-class parent would make the child build under machine keys, so the row ids would differ from the run book and `--send-all` would be refused.
  Reflect.deleteProperty(env, 'OARS_HOST_CLASS');
  return env;
};

/** The file `oars pool login` writes, as the CLI names it (not the platform login's `credentials.json`). */
const signInFile = (store: Store): string => signInsFile(join(store.configRoot, 'oars', 'sessions'));
const termsFile = (store: Store): string => join(store.configRoot, 'claude', 'session-commons', 'exclusion-terms.txt');

const isScript = (oars: string): boolean => ['.js', '.mjs', '.cjs'].includes(extname(oars).toLowerCase());

/** A part with a space is quoted so the printed line can be pasted into a shell. */
const quoteIfSpaced = (part: string): string => (part.includes(' ') ? `"${part}"` : part);

/** The command line as it runs: a script is run by this node, so the printed line names it. */
const commandLine = (oars: string, args: string[]): string => [...(isScript(oars) ? [process.execPath] : []), oars, ...args].map(quoteIfSpaced).join(' ');

/** A `.js` file is run by this node, a `.cmd` or `.bat` through the shell on Windows, anything else directly. */
const launch = (oars: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((done) => {
    const extension = extname(oars).toLowerCase();
    const script = isScript(oars);
    const shell = process.platform === 'win32' && (extension === '.cmd' || extension === '.bat');
    const child = spawn(script ? process.execPath : oars, script ? [oars, ...args] : args, { env, stdio: 'inherit', shell });
    child.on('error', () => {
      done(-1);
    });
    child.on('close', (code) => {
      done(code ?? -1);
    });
  });

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const USAGE = 'usage: deposit-fleet <run book> --allowed-signers <file> --oars <path> [--identity <id>] [--fleet <file>] [--confirm]';

/** The fleet manifest in the package. A script that bundles this file passes its own path: `import.meta.url` does not point here once bundled. */
export const FLEET_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet-manifest.json');

/** Reads and checks the fleet manifest; the error names the file and the reason. */
const loadFleet = async (file: string): Promise<FleetManifest> => {
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`fleet manifest ${file} cannot be read`);
  });
  try {
    return parseFleet(text);
  } catch (error) {
    throw new Error(`fleet manifest ${file}: ${error instanceof Error ? error.message : 'is not valid'}`, { cause: error });
  }
};

export const main = async (argv: string[], print: (line: string) => void, clock: () => Date = () => new Date(), defaultFleet: string = FLEET_FILE): Promise<number> => {
  const runBook = argv[0];
  const allowed = flag(argv, '--allowed-signers');
  const oars = flag(argv, '--oars');
  if (runBook === undefined || runBook.startsWith('--') || allowed === undefined || oars === undefined) {
    print(USAGE);
    return 2;
  }
  const confirm = argv.includes('--confirm');
  try {
    const fleetFile = resolve(flag(argv, '--fleet') ?? defaultFleet);
    const fleet = await loadFleet(fleetFile);
    const path = resolve(runBook);
    const dir = dirname(path);
    const book = parseRunBook(await readFile(path, 'utf8'), dir);
    const refuse = (reason: string): number => {
      print(`deposit-fleet ${book.orderId}: refused: ${reason}`);
      return 1;
    };
    if (book.manifestVersion !== fleet.version) return refuse(`run book names manifest ${book.manifestVersion} but the fleet manifest is ${fleet.version}`);
    if (book.status !== 'complete') return refuse(`run book status is ${book.status}, only a complete run book is deposited`);
    const verified = await verifyRunBook(path, allowed, flag(argv, '--identity'));
    if (!verified.ok) return refuse(`run book signature not verified: ${verified.message}`);
    const earliest = book.newestEnd + SESSION_IDLE_HOURS * HOUR_MS;
    if (clock().getTime() < earliest) return refuse(`the newest run ended under ${String(SESSION_IDLE_HOURS)} hours ago; the earliest time deposit-fleet will run is ${new Date(earliest).toISOString()}`);
    // Every store is checked before any runs, so a missing file stops the whole step and never leaves some stores sent.
    for (const store of book.stores) {
      if (!(await exists(signInFile(store)))) return refuse(`store ${store.name} has no sign-in file: ${signInFile(store)} (run oars pool login with this config root)`);
      if (!(await exists(termsFile(store)))) return refuse(`store ${store.name} has no exclusion-terms file: ${termsFile(store)}`);
    }
    const steps: Step[] = [
      { label: 'build', args: ['pool', 'deposit'] },
      { label: 'show', args: ['pool', 'outbox'] },
      { label: 'send', args: ['pool', 'deposit', '--send-all'] },
    ];
    print(`deposit-fleet ${book.orderId}: ${confirm ? 'depositing' : 'dry run (add --confirm to send)'}`);
    if (!confirm) {
      for (const store of book.stores) {
        print(`store ${store.name}: config root ${store.configRoot}`);
        print(`  expects ${String(store.expected.length)} sessions: ${store.expected.join(' ')}`);
        for (const [at, step] of steps.entries()) print(`  command ${String(at + 1)} (${step.label}): ${commandLine(oars, step.args)}`);
        print(`  environment: ${CONFIG_VARIABLE}=${quoteIfSpaced(store.configRoot)} CLAUDE_CONFIG_DIR=${quoteIfSpaced(join(store.configRoot, 'claude'))}`);
      }
      return 0;
    }
    const failed: string[] = [];
    for (const store of book.stores) {
      // Build, then show (which marks each batch shown, the condition of a send), then send; the first non-zero exit ends this store.
      const exitCodes: number[] = [];
      for (const step of steps) {
        const exitCode = await launch(oars, step.args, childEnv(store.configRoot));
        exitCodes.push(exitCode);
        if (exitCode !== 0) {
          print(`store ${store.name}: ${step.label} step failed (exit ${String(exitCode)}), stopped${step.label === 'send' ? '; if the covenant is not accepted, run oars pool deposit --send <hash> at a terminal with this config root' : ''}`);
          failed.push(`${store.name} (exit ${String(exitCode)})`);
          break;
        }
      }
      await appendFile(join(dir, `${book.orderId}.deposit-record.jsonl`), `${JSON.stringify({ store: store.name, time: clock().toISOString(), exitCodes, expected: store.expected })}
`);
    }
    print(`deposited ${String(book.stores.length - failed.length)} of ${String(book.stores.length)} stores${failed.length === 0 ? '' : `; failed: ${failed.join(', ')}`}`);
    return failed.length === 0 ? 0 : 1;
  } catch (error) {
    print(`deposit-fleet: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  }
};
