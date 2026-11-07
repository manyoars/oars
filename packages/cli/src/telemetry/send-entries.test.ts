// The two built entries that send: `dist/hook-bin.js nightly` (the nightly task) and `dist/telemetry/send-main.js <folder>` (the detached daily send), run as processes against a fake pool
// on loopback, plus the detached start's spawn arguments. The in-process tests of `send.ts` cannot show that the wiring exists: delete the nightly line in `hook-bin.ts`, or send on every
// hook event, or point the spawn at the wrong file, and they stay green. Like `gate/hook-bin.test.ts` this reads `dist/`, which the root `check` builds before the tests run; without a build
// it is skipped. Every run sets APPDATA (and the other config roots) to a temp folder.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import type { HelperSpawn } from '../gate/hook-fill.js';
import { markNoticeShown } from './consent.js';
import { spawnDetachedSend } from './send.js';
import { appendLine, readSpool } from './spool.js';

const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const sendMain = fileURLToPath(new URL('../../dist/telemetry/send-main.js', import.meta.url));
const built = existsSync(hookBin) && existsSync(sendMain);

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

interface Received {
  method: string;
  url: string;
  events: number;
}

/** A pool on loopback that answers 201 to everything and counts what it was asked. */
const serve = async (): Promise<{ origin: string; received: Received[] }> => {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(text);
      const events: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'events') : undefined;
      received.push({ method: request.method ?? '', url: request.url ?? '', events: Array.isArray(events) ? events.length : 0 });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  return { origin: `http://127.0.0.1:${String(typeof bound === 'object' && bound !== null ? bound.port : 0)}`, received };
};

const eventLine = JSON.stringify({ v: 1, id: 'ignored', at: '2026-11-06T12:00:00.000Z', type: 'command', cli: '0.3.0', os: 'linux', data: { path: ['doctor'], flags: [], durationMs: 5, exitCode: 0 } });

/** A temp config root with one event spooled and the notice shown, so only the entry under test stands between the spool and the server. */
const home = (): { root: string; dir: string; env: NodeJS.ProcessEnv } => {
  const root = mkdtempSync(join(tmpdir(), 'oars-send-entry-'));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', APPDATA: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root };
  const dir = join(defaultConfigDir(env, process.platform, root), 'oars', 'telemetry');
  expect(dir.startsWith(root)).toBe(true);
  appendLine(dir, eventLine);
  expect(markNoticeShown(dir, () => 0)).toBe(true);
  return { root, dir, env };
};

/** Runs a built entry to its end, with `input` on stdin, and answers its exit code. Async: the fake pool lives in this process and must keep answering. */
const run = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, input = ''): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { env, cwd, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the entry did not end in 30 s'));
    }, 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin.end(input);
  });

describe.skipIf(!built)('the built nightly send', () => {
  it('makes one POST /v1/telemetry for the nightly event and leaves the spool empty', async () => {
    const fake = await serve();
    const { root, dir, env } = home();
    expect(await run([hookBin, 'nightly'], { ...env, OARS_POOL_URL: fake.origin }, root)).toBe(0);
    expect(fake.received).toEqual([{ method: 'POST', url: '/v1/telemetry', events: 1 }]);
    expect(readSpool(dir)).toEqual([]);
  }, 60_000);

  it('makes no request for a session hook, with the same spool, notice, and server', async () => {
    const fake = await serve();
    const { root, dir, env } = home();
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'yarn add left-pad' }, cwd: root, permission_mode: 'default' });
    expect(await run([hookBin, 'pre-tool'], { ...env, OARS_POOL_URL: fake.origin }, root, payload)).toBe(0);
    expect(await run([hookBin, 'session-start'], { ...env, OARS_POOL_URL: fake.origin }, root, '{}')).toBe(0);
    expect(await run([hookBin, 'stop'], { ...env, OARS_POOL_URL: fake.origin }, root, '{}')).toBe(0);
    expect(fake.received).toEqual([]);
    expect(readSpool(dir)).toHaveLength(1);
  }, 60_000);

  it('makes no nightly request without a server configured', async () => {
    const fake = await serve();
    const { root, dir, env } = home();
    expect(await run([hookBin, 'nightly'], env, root)).toBe(0);
    expect(fake.received).toEqual([]);
    expect(readSpool(dir)).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!built)('the built detached send entry', () => {
  it('sends the spool it is given in one request and empties it', async () => {
    const fake = await serve();
    const { root, dir, env } = home();
    expect(await run([sendMain, dir], { ...env, OARS_POOL_URL: fake.origin }, root)).toBe(0);
    expect(fake.received).toEqual([{ method: 'POST', url: '/v1/telemetry', events: 1 }]);
    expect(readSpool(dir)).toEqual([]);
  }, 60_000);

  it('exits 0 and sends nothing when it is given no folder', async () => {
    const fake = await serve();
    const { root, env } = home();
    expect(await run([sendMain], { ...env, OARS_POOL_URL: fake.origin }, root)).toBe(0);
    expect(fake.received).toEqual([]);
  }, 60_000);
});

describe('spawnDetachedSend', () => {
  it('starts send-main.js next to send.js with the folder, detached with no stdio, and lets go of it', () => {
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    const unref = vi.fn();
    const child = new EventEmitter();
    const start: HelperSpawn = (command, args, options) => {
      calls.push({ command, args, options });
      return Object.assign(child, { unref });
    };
    spawnDetachedSend('/telemetry', start);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    const [entry, folder] = calls[0]?.args ?? [];
    expect(basename(entry ?? '')).toBe('send-main.js');
    // Next to the module that starts it, so the built `dist/telemetry/send.js` finds `dist/telemetry/send-main.js`.
    expect(dirname(entry ?? '')).toBe(dirname(fileURLToPath(new URL('./send.js', import.meta.url))));
    expect(folder).toBe('/telemetry');
    expect(calls[0]?.args).toHaveLength(2);
    expect(calls[0]?.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(unref).toHaveBeenCalledTimes(1);
    // A child that cannot start emits `error`; nothing may throw from it.
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });
});
