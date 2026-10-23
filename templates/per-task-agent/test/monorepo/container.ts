// Runs the built image for the container smoke test: `docker run` on a free loopback port, with the host reachable as
// host.docker.internal (Docker Desktop has it; the flag adds it on Linux runners).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const docker = async (...args: string[]): Promise<string> => (await run('docker', args)).stdout.trim();
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface ContainerEnv {
  [name: string]: string;
}

export interface Container {
  /** The published port on 127.0.0.1, e.g. http://127.0.0.1:49153 */
  url: string;
  logs: () => Promise<string>;
  stop: () => Promise<void>;
}

const HEALTH_TIMEOUT_MS = 30_000;

export const startContainer = async (image: string, env: ContainerEnv): Promise<Container> => {
  const variables = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  const id = await docker('run', '-d', '--rm', '--add-host=host.docker.internal:host-gateway', '-p', '127.0.0.1::8080', ...variables, image);
  const logs = async (): Promise<string> => {
    const { stdout, stderr } = await run('docker', ['logs', id]);
    return `${stdout}${stderr}`;
  };
  const stop = async (): Promise<void> => {
    await docker('rm', '-f', id);
  };
  const mapping = (await docker('port', id, '8080/tcp')).split('\n')[0] ?? '';
  const url = `http://127.0.0.1:${mapping.slice(mapping.lastIndexOf(':') + 1)}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    const healthy = await fetch(`${url}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return { url, logs, stop };
    if (Date.now() > deadline) {
      const output = await logs().catch(() => 'no logs: the container is gone');
      await stop().catch(() => undefined);
      throw new Error(`${image} did not answer /healthz within ${String(HEALTH_TIMEOUT_MS)} ms:\n${output}`);
    }
    await pause(200);
  }
};
