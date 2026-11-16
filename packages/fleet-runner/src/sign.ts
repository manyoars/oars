// The sign step (spec section 7): the operator signs a finished run book with the company's Ed25519 run-book key by shelling out to `ssh-keygen -Y sign`, and a buyer
// checks it with `ssh-keygen -Y verify`. There is no signing code of our own, so there is no key handling here: the key path goes to ssh-keygen and nowhere else.
// `npm run sign -w packages/fleet-runner -- <run book> <key>` and `npm run verify-run-book -w packages/fleet-runner -- <run book> <allowed-signers> [<identity>]`.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** The namespace the signature is bound to; verify refuses a signature made under another. */
export const NAMESPACE = 'manyoars-runbook';
/** The principal an allowed-signers line names for the company's key, when the caller names none. */
export const DEFAULT_IDENTITY = 'run-book@manyoars.com';

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

const sshKeygen = (args: string[], input: Buffer | null): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => reject(new Error(`ssh-keygen could not be run (is OpenSSH installed and on PATH?): ${error.message}`)));
    child.on('close', (code) => resolve({ status: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    // An early exit closes stdin on us; the exit status is what reports it.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? undefined);
  });

/** Throws unless the first line is a run book header whose status is `complete`: an incomplete or voided order is never signed. */
const requireComplete = (bytes: Buffer): void => {
  let header: unknown;
  try {
    header = JSON.parse(bytes.toString('utf8').split('\n')[0] ?? '');
  } catch {
    throw new Error('run book header is not JSON');
  }
  const status: unknown = typeof header === 'object' && header !== null ? Reflect.get(header, 'status') : undefined;
  if (status !== 'complete') throw new Error(`run book status is ${typeof status === 'string' ? status : 'missing'}, only a complete run book is signed`);
};

/** Signs `runBook` with the key at `keyPath`; the detached signature is written beside it as `<run book>.sig`, and that path is returned. */
export const signRunBook = async (runBook: string, keyPath: string): Promise<string> => {
  requireComplete(await readFile(runBook));
  const ran = await sshKeygen(['-Y', 'sign', '-n', NAMESPACE, '-f', keyPath, runBook], null);
  if (ran.status !== 0) throw new Error(`ssh-keygen -Y sign failed: ${ran.stderr.trim()}`);
  return `${runBook}.sig`;
};

export interface Verified {
  ok: boolean;
  message: string;
}

/** Checks `<run book>.sig` against the allowed-signers file with `ssh-keygen -Y verify`; the run book goes in on stdin so a changed byte fails. */
export const verifyRunBook = async (runBook: string, allowedSigners: string, identity: string = DEFAULT_IDENTITY): Promise<Verified> => {
  const ran = await sshKeygen(['-Y', 'verify', '-f', allowedSigners, '-I', identity, '-n', NAMESPACE, '-s', `${runBook}.sig`], await readFile(runBook));
  return { ok: ran.status === 0, message: (ran.status === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() };
};

const USAGE = 'usage: sign <run book> <key path> | verify <run book> <allowed-signers file> [<identity>]';

export const main = async (argv: string[], print: (line: string) => void): Promise<number> => {
  const [verb, book, second, third] = argv;
  if (book === undefined || second === undefined || (verb !== 'sign' && verb !== 'verify')) {
    print(USAGE);
    return 2;
  }
  try {
    if (verb === 'sign') {
      print(`signature: ${await signRunBook(book, second)}`);
      return 0;
    }
    const verified = await verifyRunBook(book, second, third);
    print(verified.ok ? `verified: ${verified.message}` : `not verified: ${verified.message}`);
    return verified.ok ? 0 : 1;
  } catch (error) {
    print(`${verb}: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  }
};
