// The deposit step (spec section 8), a later command than the run: `npm run deposit-fleet -w packages/fleet-runner -- <run book> --allowed-signers <file> --oars <path> [--identity <id>] [--confirm]`.
// For each store folder the run wrote, it runs the public `oars pool deposit --send-all` with that store's config root in the child's environment only, so the child reads that store, that sign-in file,
// and that exclusion-terms file, and no other. Without `--confirm` it prints what it would do and runs nothing. It never edits the signed run book: what it did goes to `<order id>.deposit-record.jsonl` beside it.
import { spawn } from 'node:child_process';
import { access, appendFile, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { SESSION_IDLE_HOURS } from '../../cli/src/sessions/pool-wire.js';
import { objectAt, parseJson, stringAt } from './json.js';
import { verifyRunBook } from './sign.js';
import { folderOf } from './stores.js';

const HOUR_MS = 60 * 60 * 1000;

interface Store {
  name: string;
  configRoot: string;
  /** The pool row ids the store's valid runs are expected to deposit under, in run order. */
  expected: string[];
}

interface Parsed {
  orderId: string;
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
  return { orderId, status: typeof header.status === 'string' ? header.status : 'missing', newestEnd, stores: [...stores.values()] };
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
  return env;
};

const signInFile = (store: Store): string => join(store.configRoot, 'oars', 'credentials.json');
const termsFile = (store: Store): string => join(store.configRoot, 'claude', 'session-commons', 'exclusion-terms.txt');

/** A `.js` file is run by this node, a `.cmd` or `.bat` through the shell on Windows, anything else directly. */
const launch = (oars: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((done) => {
    const extension = extname(oars).toLowerCase();
    const script = extension === '.js' || extension === '.mjs' || extension === '.cjs';
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

const USAGE = 'usage: deposit-fleet <run book> --allowed-signers <file> --oars <path> [--identity <id>] [--confirm]';

export const main = async (argv: string[], print: (line: string) => void, clock: () => Date = () => new Date()): Promise<number> => {
  const runBook = argv[0];
  const allowed = flag(argv, '--allowed-signers');
  const oars = flag(argv, '--oars');
  if (runBook === undefined || runBook.startsWith('--') || allowed === undefined || oars === undefined) {
    print(USAGE);
    return 2;
  }
  const confirm = argv.includes('--confirm');
  try {
    const path = resolve(runBook);
    const dir = dirname(path);
    const book = parseRunBook(await readFile(path, 'utf8'), dir);
    const refuse = (reason: string): number => {
      print(`deposit-fleet ${book.orderId}: refused: ${reason}`);
      return 1;
    };
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
    const args = ['pool', 'deposit', '--send-all'];
    print(`deposit-fleet ${book.orderId}: ${confirm ? 'depositing' : 'dry run (add --confirm to send)'}`);
    if (!confirm) {
      for (const store of book.stores) {
        print(`store ${store.name}: config root ${store.configRoot}`);
        print(`  expects ${String(store.expected.length)} sessions: ${store.expected.join(' ')}`);
        print(`  command: ${oars} pool deposit --send-all`);
        print(`  environment: ${CONFIG_VARIABLE}=${store.configRoot} CLAUDE_CONFIG_DIR=${join(store.configRoot, 'claude')}`);
      }
      return 0;
    }
    const failed: string[] = [];
    for (const store of book.stores) {
      const exitCode = await launch(oars, args, childEnv(store.configRoot));
      await appendFile(join(dir, `${book.orderId}.deposit-record.jsonl`), `${JSON.stringify({ store: store.name, time: clock().toISOString(), exitCode, expected: store.expected })}\n`);
      if (exitCode !== 0) failed.push(`${store.name} (exit ${String(exitCode)})`);
    }
    print(`deposited ${String(book.stores.length - failed.length)} of ${String(book.stores.length)} stores${failed.length === 0 ? '' : `; failed: ${failed.join(', ')}`}`);
    return failed.length === 0 ? 0 : 1;
  } catch (error) {
    print(`deposit-fleet: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  }
};
