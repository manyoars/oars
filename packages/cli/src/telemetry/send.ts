// The sender: the only code that sends telemetry. It runs from the detached sender (hook-bin.js nightly), and at most once a day from an interactive command as a detached process; never on a hook path, and
// nothing waits for it. Before any byte leaves it calls `telemetrySendAllowed` (telemetry on, notice shown) and sends to the pool server in `OARS_POOL_URL`, else the Many Oars pool, the same default `oars pool`
// reads and with the same rules (https, or http to this machine).
//
// A batch is up to 250 events. Only a 2xx clears what was sent; anything else (an error status, a redirect, a timeout, a refused connection) keeps the spool for the next try. That makes
// delivery at least once: a batch the server kept whose answer was lost is sent again.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir } from '../credentials.js';
import type { HelperSpawn } from '../gate/hook-fill.js';
import { NOTICE_VERSION, telemetrySendAllowed } from './consent.js';
import type { TelemetryRuntime } from './record.js';
import { installId, readSpool, spoolPaths } from './spool.js';

/** The pool route takes at most this many events (Analytics Engine's per-request write limit). */
export const BATCH_EVENTS = 250;

/** One request's whole life, connect to last byte; a server that is slower than this is treated as down. */
export const SEND_TIMEOUT_MS = 10_000;

const DAY_MS = 86_400_000;
const MARK = 'last-send';

export interface SendDeps {
  env: NodeJS.ProcessEnv;
  /** `<config>/oars/telemetry`. */
  dir: string;
  now: () => number;
  /** The network, for a test; absent means the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface SendResult {
  outcome: 'sent' | 'failed' | 'empty' | 'not-allowed' | 'no-server' | 'not-due';
  /** Events the server took (and that were cleared from the spool). */
  sent: number;
  /** Requests made, including one that failed. */
  requests: number;
}

/** The pool server, validated the way `oars pool` does it, or undefined. The pool command's code is loaded only after sending is allowed, so a run with telemetry off or the notice unshown does not pay for it. */
const serverOf = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  try {
    const { poolServer } = await import('../sessions/pool-command.js');
    return poolServer(env, 'telemetry');
  } catch {
    return undefined;
  }
};

/** The route answers 400 to an event whose `type` is not a string of 1 to 64 characters, and a failed batch blocks every later send, so such an object is junk here (the pool's `telemetry.ts` holds the rule). */
const eventOf = (line: string): object | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const type: unknown = Reflect.get(parsed, 'type');
    return typeof type === 'string' && type.length >= 1 && type.length <= 64 ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** True only for a 2xx. A redirect is not followed: a pool never redirects a POST, and a 3xx from anything else is not the pool. */
const post = async (url: string, install: string, events: object[], deps: SendDeps): Promise<boolean> => {
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ install, notice: NOTICE_VERSION, events }),
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
};

/** Takes the sent lines out of the spool, by content and oldest first, so an event written after the read stays and a rotation in between does not matter. A file that cannot be rewritten keeps its lines, and they are sent again. */
const dropLines = (dir: string, gone: readonly string[]): void => {
  const counts = new Map<string, number>();
  for (const line of gone) counts.set(line, (counts.get(line) ?? 0) + 1);
  const { previous, current } = spoolPaths(dir);
  for (const path of [previous, current]) {
    try {
      const lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      const kept = lines.filter((line) => {
        const left = counts.get(line) ?? 0;
        if (left === 0) return true;
        counts.set(line, left - 1);
        return false;
      });
      if (kept.length === lines.length) continue;
      const scratch = `${path}.tmp`;
      writeFileSync(scratch, kept.map((line) => `${line}\n`).join(''));
      renameSync(scratch, path);
    } catch {
      // No such file, or one another process holds: its lines stay, and a later send takes them.
    }
  }
};

export const writeMark = (dir: string, now: number): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARK), String(now));
};

/** Whether a day has passed since the last send was started. A missing, unreadable, or future mark counts as due. */
export const dueForSend = (dir: string, now: number): boolean => {
  let last: number;
  try {
    last = Number(readFileSync(join(dir, MARK), 'utf8').trim());
  } catch {
    return true;
  }
  return !Number.isFinite(last) || last > now || now - last >= DAY_MS;
};

/** Sends what the spool holds. Never throws. */
export const sendSpool = async (deps: SendDeps): Promise<SendResult> => {
  const tally = { sent: 0, requests: 0 };
  const finish = (outcome: SendResult['outcome']): SendResult => ({ outcome, ...tally });
  if (!telemetrySendAllowed(deps.env, deps.dir)) return finish('not-allowed');
  const server = await serverOf(deps.env);
  if (server === undefined) return finish('no-server');
  try {
    const events: { line: string; event: object }[] = [];
    const junk: string[] = [];
    for (const line of readSpool(deps.dir)) {
      const event = eventOf(line);
      if (event === undefined) junk.push(line);
      else events.push({ line, event });
    }
    if (events.length === 0) return finish('empty');
    const install = installId(deps.dir);
    writeMark(deps.dir, deps.now());
    const sent: string[] = [];
    let failed = false;
    for (let at = 0; at < events.length && !failed; at += BATCH_EVENTS) {
      const batch = events.slice(at, at + BATCH_EVENTS);
      tally.requests += 1;
      if (await post(`${server}/v1/telemetry`, install, batch.map(({ event }) => event), deps)) {
        tally.sent += batch.length;
        sent.push(...batch.map(({ line }) => line));
      } else failed = true;
    }
    // A line that is not an event can never be sent, so it goes with the first batch the server takes.
    if (sent.length > 0) dropLines(deps.dir, [...sent, ...junk]);
    return finish(failed ? 'failed' : 'sent');
  } catch {
    return finish('failed');
  }
};

/**
 * The detached sender's telemetry send, in the telemetry folder under the config folder. The sender runs up to about hourly, but telemetry goes at most once a
 * day, on the same mark a command's daily send uses; events recorded by the runs in between wait in the spool for the next day's batch.
 */
export const sendNightly = async (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, now: () => number): Promise<SendResult> => {
  const dir = join(defaultConfigDir(env, platform, home), 'oars', 'telemetry');
  if (!dueForSend(dir, now())) return { outcome: 'not-due', sent: 0, requests: 0 };
  return sendSpool({ env, dir, now });
};

/**
 * Called after an interactive command: starts one detached send, at most once a day, when sending is allowed. The mark is written first, so two commands at
 * once start one. Nothing here throws or waits, and the run has no way to start a send unless `main.ts` gave it one.
 */
export const startDailySend = (runtime: TelemetryRuntime, env: NodeJS.ProcessEnv, now: number): void => {
  try {
    if (runtime.spawnSend === undefined) return;
    if (!telemetrySendAllowed(env, runtime.dir) || !dueForSend(runtime.dir, now)) return;
    writeMark(runtime.dir, now);
    runtime.spawnSend(runtime.dir);
  } catch {
    // Telemetry is never allowed to change what a command does.
  }
};

/** Starts `send-main.js` detached with no stdio and never waits for it, as the gate's helper is started. */
export const spawnDetachedSend = (dir: string, start: HelperSpawn = spawn): void => {
  const child = start(process.execPath, [fileURLToPath(new URL('./send-main.js', import.meta.url)), dir], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
};
