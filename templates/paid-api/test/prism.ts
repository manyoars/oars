// Starts Prism (strict request validation) on openapi/public.json for the contract test and the container smoke test.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PrismServer {
  /** Where billing is mocked, e.g. http://127.0.0.1:41233 */
  url: string;
  stop: () => Promise<void>;
}

export interface PrismOptions {
  /** Prism's listen address; the smoke test needs 0.0.0.0 so a container can reach it. */
  host?: string;
  /** Edits the spec text before Prism reads it (the smoke test pins an answer here). */
  edit?: (spec: string) => string;
}

const SPEC = fileURLToPath(new URL('../../../openapi/public.json', import.meta.url));
const START_TIMEOUT_MS = 45_000;

// Springdoc declares every billing response as `*/*`, which Prism cannot serialize (it answers 500 to a valid call). Billing
// really answers application/json, so the copy Prism reads says so; request schemas, the thing under test, are untouched.
export const prismSpec = async (): Promise<string> => (await readFile(SPEC, 'utf8')).replaceAll('"*/*":', '"application/json":');

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no free port'));
      });
    });
  });

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntilListening = async (child: ChildProcess, port: number, output: () => string): Promise<void> => {
  const exited = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`prism exited with ${String(code)} before it listened:\n${output()}`));
    });
  });
  const listening = (async () => {
    const running = (): boolean => child.exitCode === null && child.signalCode === null;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (running() && Date.now() < deadline) {
      if (await accepts(port)) return;
      await pause(100);
    }
    throw new Error(`prism did not listen on ${String(port)} within ${String(START_TIMEOUT_MS)} ms:\n${output()}`);
  })();
  await Promise.race([listening, exited]);
};

export const startPrism = async (options: PrismOptions = {}): Promise<PrismServer> => {
  const directory = await mkdtemp(join(tmpdir(), 'oars-prism-'));
  const spec = join(directory, 'public.json');
  await writeFile(spec, (options.edit ?? ((text) => text))(await prismSpec()));
  const port = await freePort();
  const bin = createRequire(import.meta.url).resolve('@stoplight/prism-cli/dist/index.js');
  const args = [bin, 'mock', '--errors', '-v', 'warn', '-h', options.host ?? '127.0.0.1', '-p', String(port), spec];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
  }
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await waitUntilListening(child, port, () => log);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: `http://127.0.0.1:${String(port)}`, stop };
};
