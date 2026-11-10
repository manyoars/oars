// The sender: what leaves the machine, when, and what happens to the spool after. A fake pool server on loopback counts the requests, so "sends nothing" is a count of zero beside a run
// that does send. Every test sets APPDATA to a temp folder and confirms the telemetry folder is under it, so none touches the real one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, type RunDeps } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { harness } from '../test-support.js';
import { markNoticeShown, NOTICE_VERSION, setEnabled } from './consent.js';
import { BATCH_EVENTS, dueForSend, sendNightly, sendSpool, startDailySend } from './send.js';
import { appendLine, installId, readSpool, spoolPaths } from './spool.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Received {
  body: unknown;
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

interface Fake {
  origin: string;
  received: Received[];
}

// Keeps its socket: the sender's own transport (status handling, redirects, hangs) is what these tests cover.
/** A pool server on loopback. `answer` picks the status of request number `at` (from 0); `onRequest` runs before it answers. */
const serve = async (answer: (at: number) => number | 'hang' = () => 201, onRequest: () => void = () => undefined): Promise<Fake> => {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (text += chunk));
    request.on('end', () => {
      received.push({ body: JSON.parse(text), method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      onRequest();
      const status = answer(received.length - 1);
      if (status === 'hang') return;
      response.writeHead(status, status >= 300 && status < 400 ? { location: '/elsewhere' } : { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  return { origin: `http://127.0.0.1:${String(typeof bound === 'object' && bound !== null ? bound.port : 0)}`, received };
};

/** The `events` of a request body the fake kept. */
const eventsOf = (request: Received | undefined): unknown[] => {
  const events: unknown = typeof request?.body === 'object' && request.body !== null ? Reflect.get(request.body, 'events') : undefined;
  return Array.isArray(events) ? events : [];
};

const folder = (): { appData: string; dir: string } => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-send-'));
  roots.push(appData);
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return { appData, dir: join(configDir, 'oars', 'telemetry') };
};

const eventLine = (n: number): string => JSON.stringify({ v: 1, id: 'ignored', at: new Date(1_800_000_000_000 + n).toISOString(), type: 'command', cli: '0.3.0', os: 'linux', data: { path: ['doctor'], flags: [], durationMs: n, exitCode: 0 } });

/** A spool of `count` events, the notice shown, so the only thing between it and the server is what the test varies. */
const spooled = (count: number, shown = true): string => {
  const { dir } = folder();
  for (let n = 0; n < count; n += 1) appendLine(dir, eventLine(n));
  if (shown) expect(markNoticeShown(dir, () => 0)).toBe(true);
  return dir;
};

const sendWith = (dir: string, env: NodeJS.ProcessEnv, extra: { timeoutMs?: number } = {}): ReturnType<typeof sendSpool> => sendSpool({ env, dir, now: () => 1_800_000_100_000, ...extra });

describe('sendSpool', () => {
  it('sends the spool to the configured server in one request, then clears what it sent', async () => {
    const fake = await serve();
    const dir = spooled(3);
    const result = await sendWith(dir, { OARS_POOL_URL: fake.origin });
    expect(result).toEqual({ outcome: 'sent', sent: 3, requests: 1 });
    expect(fake.received).toHaveLength(1);
    const [only] = fake.received;
    expect(only?.method).toBe('POST');
    expect(only?.url).toBe('/v1/telemetry');
    expect(only?.headers['content-type']).toBe('application/json');
    // Exactly the spooled lines, and the install id the folder keeps.
    expect(only?.body).toEqual({ install: installId(dir), notice: NOTICE_VERSION, events: [0, 1, 2].map((n): unknown => JSON.parse(eventLine(n))) });
    expect(readSpool(dir)).toEqual([]);
  });

  it('sends no credential: a header carries nothing but the batch', async () => {
    const fake = await serve();
    await sendWith(spooled(1), { OARS_POOL_URL: fake.origin });
    expect(Object.keys(fake.received[0]?.headers ?? {}).filter((name) => ['authorization', 'cookie'].includes(name))).toEqual([]);
  });

  it.each([
    ['OARS_TELEMETRY=0', { OARS_TELEMETRY: '0' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
  ])('sends nothing with %s, and leaves the spool', async (_name, off) => {
    const fake = await serve();
    const dir = spooled(2);
    const result = await sendWith(dir, { OARS_POOL_URL: fake.origin, ...off });
    expect(result).toEqual({ outcome: 'not-allowed', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('sends nothing after oars telemetry off', async () => {
    const fake = await serve();
    const dir = spooled(2);
    setEnabled(dir, false);
    expect((await sendWith(dir, { OARS_POOL_URL: fake.origin })).outcome).toBe('not-allowed');
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('sends nothing until the notice has been shown', async () => {
    const fake = await serve();
    const dir = spooled(2, false);
    const result = await sendWith(dir, { OARS_POOL_URL: fake.origin });
    expect(result).toEqual({ outcome: 'not-allowed', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it.each([
    ['none configured', {}],
    ['an empty one', { OARS_POOL_URL: '' }],
  ])('sends to the Many Oars pool with %s, and clears what it sent', async (_name, env) => {
    const dir = spooled(2);
    const urls: string[] = [];
    const fake: typeof fetch = (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    expect(await sendSpool({ env, dir, now: () => 1_800_000_100_000, fetch: fake })).toEqual({ outcome: 'sent', sent: 2, requests: 1 });
    expect(urls).toEqual(['https://pool.manyoars.com/v1/telemetry']);
    expect(readSpool(dir)).toHaveLength(0);
  });

  it.each([
    ['one that is not a URL', { OARS_POOL_URL: 'not a url' }],
    ['plain http to another host', { OARS_POOL_URL: 'http://pool.example.test' }],
  ])('sends nothing with %s, and leaves the spool', async (_name, env) => {
    const fake = await serve();
    const dir = spooled(2);
    expect(await sendWith(dir, env)).toEqual({ outcome: 'no-server', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('has nothing to send from an empty spool, and makes no request', async () => {
    const fake = await serve();
    expect(await sendWith(spooled(0), { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'empty', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(0);
  });

  it('keeps the whole spool on a 500, and sends it again next time', async () => {
    const fake = await serve((at) => (at === 0 ? 500 : 201));
    const dir = spooled(3);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'failed', sent: 0, requests: 1 });
    expect(readSpool(dir)).toEqual([0, 1, 2].map(eventLine));
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'sent', sent: 3, requests: 1 });
    expect(readSpool(dir)).toEqual([]);
  });

  it.each([
    ['a 400', 400],
    ['a 413', 413],
    ['a redirect', 302],
  ])('keeps the spool on %s: only a 2xx clears', async (_name, status) => {
    const fake = await serve(() => status);
    const dir = spooled(2);
    expect((await sendWith(dir, { OARS_POOL_URL: fake.origin })).outcome).toBe('failed');
    expect(fake.received).toHaveLength(1);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('keeps the spool when the server does not answer in time', async () => {
    const fake = await serve(() => 'hang');
    const dir = spooled(2);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin }, { timeoutMs: 100 })).toEqual({ outcome: 'failed', sent: 0, requests: 1 });
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('keeps the spool when nothing is listening', async () => {
    const fake = await serve();
    const dir = spooled(2);
    const closed = new URL(fake.origin);
    servers[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await sendWith(dir, { OARS_POOL_URL: closed.origin })).outcome).toBe('failed');
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('sends in batches of 250, and a later batch that fails keeps its events and everything after', async () => {
    const fake = await serve((at) => (at === 2 ? 500 : 201));
    const dir = spooled(BATCH_EVENTS * 2 + 100);
    expect(BATCH_EVENTS).toBe(250);
    const result = await sendWith(dir, { OARS_POOL_URL: fake.origin });
    expect(result).toEqual({ outcome: 'failed', sent: 500, requests: 3 });
    const sizes = fake.received.map((request) => eventsOf(request).length);
    expect(sizes).toEqual([250, 250, 100]);
    // The two batches the server took are gone; the one it refused is still there, in order.
    expect(readSpool(dir)).toEqual(Array.from({ length: 100 }, (_unused, n) => eventLine(500 + n)));
  });

  it('sends a spool that spans the old and the current file, oldest first', async () => {
    const fake = await serve();
    const { dir } = folder();
    // Room for two lines, so the third turns the first two into the old file.
    for (const n of [0, 1, 2]) appendLine(dir, eventLine(n), Buffer.byteLength(eventLine(0)) * 2 + 10);
    expect(existsSync(spoolPaths(dir).previous)).toBe(true);
    markNoticeShown(dir, () => 0);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'sent', sent: 3, requests: 1 });
    expect(eventsOf(fake.received[0])).toEqual([0, 1, 2].map((n): unknown => JSON.parse(eventLine(n))));
    expect(readSpool(dir)).toEqual([]);
  });

  it('keeps an event written while the batch was in flight', async () => {
    const dirs: string[] = [];
    const fake = await serve(
      () => 201,
      () => {
        appendLine(dirs[0] ?? '', eventLine(99));
      },
    );
    const dir = spooled(2);
    dirs.push(dir);
    expect((await sendWith(dir, { OARS_POOL_URL: fake.origin })).sent).toBe(2);
    expect(readSpool(dir)).toEqual([eventLine(99)]);
  });

  it('drops a line that is not an event once something has been sent, and sends nothing for it', async () => {
    const fake = await serve();
    const dir = spooled(1);
    writeFileSync(spoolPaths(dir).current, `torn{\n5\n[]\n${eventLine(0)}\n`);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'sent', sent: 1, requests: 1 });
    expect(eventsOf(fake.received[0])).toHaveLength(1);
    expect(readSpool(dir)).toEqual([]);
  });

  it('treats an object the route would refuse as junk: no string type, an empty one, or one over 64 characters', async () => {
    const fake = await serve();
    const dir = spooled(1);
    // The first lines are the oldest: if any went in a batch the route would answer 400 and block every later send.
    const refused = ['{}', '{"type":5}', '{"type":""}', `{"type":"${'x'.repeat(65)}"}`];
    writeFileSync(spoolPaths(dir).current, `${refused.join('\n')}\n${eventLine(0)}\n`);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'sent', sent: 1, requests: 1 });
    expect(eventsOf(fake.received[0])).toHaveLength(1);
    expect(readSpool(dir)).toEqual([]);
  });

  it('gives up without a request, and never throws, when the install id cannot be made', async () => {
    const fake = await serve();
    const dir = spooled(1);
    // A folder where the id file should be.
    mkdirSync(spoolPaths(dir).idFile);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toEqual({ outcome: 'failed', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(1);
  });
});

describe('dueForSend and the daily mark', () => {
  const mark = (dir: string): string => join(dir, 'last-send');

  it('is due with no mark, and not due for a day after one is written', () => {
    const dir = spooled(1);
    expect(dueForSend(dir, 1_000)).toBe(true);
    writeFileSync(mark(dir), '1000');
    expect(dueForSend(dir, 1_000 + 86_399_999)).toBe(false);
    expect(dueForSend(dir, 1_000 + 86_400_000)).toBe(true);
  });

  it('is due again when the mark is unreadable or in the future', () => {
    const dir = spooled(1);
    writeFileSync(mark(dir), 'soon');
    expect(dueForSend(dir, 5_000)).toBe(true);
    writeFileSync(mark(dir), '9000000');
    expect(dueForSend(dir, 5_000)).toBe(true);
  });
});

describe('startDailySend', () => {
  const make = (count = 1): { dir: string; spawned: string[]; runtime: { dir: string; platform: NodeJS.Platform; spawnSend: (dir: string) => void } } => {
    const dir = spooled(count);
    const spawned: string[] = [];
    return { dir, spawned, runtime: { dir, platform: 'linux', spawnSend: (target) => spawned.push(target) } };
  };
  const SERVER = { OARS_POOL_URL: 'http://127.0.0.1:9' };

  it('starts one detached send, and not another within the day', () => {
    const { dir, spawned, runtime } = make();
    startDailySend(runtime, SERVER, 5_000_000);
    startDailySend(runtime, SERVER, 5_000_000 + 3_600_000);
    expect(spawned).toEqual([dir]);
    startDailySend(runtime, SERVER, 5_000_000 + 86_400_000);
    expect(spawned).toEqual([dir, dir]);
  });

  it.each([
    ['telemetry is off', { OARS_TELEMETRY: '0', ...SERVER }],
    ['DO_NOT_TRACK is set', { DO_NOT_TRACK: '1', ...SERVER }],
  ])('starts nothing when %s, and writes no mark', (_name, env) => {
    const { dir, spawned, runtime } = make();
    startDailySend(runtime, env, 5_000_000);
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, 'last-send'))).toBe(false);
  });

  it.each([
    ['no server is configured', {}],
    ['the server setting is empty', { OARS_POOL_URL: '' }],
  ])('starts a send when %s: it goes to the Many Oars pool', (_name, env) => {
    const { dir, spawned, runtime } = make();
    startDailySend(runtime, env, 5_000_000);
    expect(spawned).toEqual([dir]);
  });

  it('starts nothing before the notice has been shown', () => {
    const dir = spooled(1, false);
    const spawned: string[] = [];
    startDailySend({ dir, platform: 'linux', spawnSend: (target) => spawned.push(target) }, SERVER, 5_000_000);
    expect(spawned).toEqual([]);
  });

  it('starts nothing in a run that has no way to start one', () => {
    const dir = spooled(1);
    startDailySend({ dir, platform: 'linux' }, SERVER, 5_000_000);
    expect(existsSync(join(dir, 'last-send'))).toBe(false);
  });

  it('writes the mark before it starts the send, so two commands at once start one', () => {
    const { dir, runtime } = make();
    const marks: string[] = [];
    runtime.spawnSend = () => marks.push(readFileSync(join(dir, 'last-send'), 'utf8'));
    startDailySend(runtime, SERVER, 5_000_000);
    expect(marks).toEqual(['5000000']);
  });

  it('survives a start that throws', () => {
    const { runtime } = make();
    runtime.spawnSend = () => {
      throw new Error('spawn failed');
    };
    expect(() => {
      startDailySend(runtime, SERVER, 5_000_000);
    }).not.toThrow();
  });
});

describe('run() and the detached send', () => {
  const setup = (env: NodeJS.ProcessEnv): { deps: RunDeps; spawned: string[]; dir: string } => {
    const { appData, dir } = folder();
    const made = harness({ APPDATA: appData, OARS_POOL_URL: 'http://127.0.0.1:9', ...env });
    const spawned: string[] = [];
    made.deps.telemetry = { dir, platform: 'linux', spawnSend: (target) => spawned.push(target) };
    markNoticeShown(dir, () => 0);
    return { deps: made.deps, spawned, dir };
  };

  it('starts the send after an ordinary command, once a day', async () => {
    const { deps, spawned, dir } = setup({});
    await run(['telemetry', 'status'], deps);
    await run(['telemetry', 'status'], deps);
    expect(spawned).toEqual([dir]);
  });

  it('never starts it on the gate hook path', async () => {
    const { deps, spawned } = setup({});
    await run(['gate', 'hook'], deps);
    expect(spawned).toEqual([]);
  });

  it('starts nothing for a command that turns telemetry off', async () => {
    const { deps, spawned } = setup({});
    await run(['telemetry', 'off'], deps);
    expect(spawned).toEqual([]);
  });
});

describe('sendNightly', () => {
  it('finds the telemetry folder under the config folder and sends what is in it', async () => {
    const fake = await serve();
    const { appData, dir } = folder();
    appendLine(dir, eventLine(0));
    markNoticeShown(dir, () => 0);
    const result = await sendNightly({ APPDATA: appData, OARS_POOL_URL: fake.origin }, 'win32', 'C:\\unused-home', () => 1_800_000_100_000);
    expect(result).toEqual({ outcome: 'sent', sent: 1, requests: 1 });
    expect(readSpool(dir)).toEqual([]);
    // The nightly counts as the day's send, so an interactive command does not send again the same day.
    expect(dueForSend(dir, 1_800_000_100_000 + 3_600_000)).toBe(false);
  });

  it('posts no second batch when the sender runs again inside the day, and posts again after it', async () => {
    const fake = await serve();
    const { appData, dir } = folder();
    const env = { APPDATA: appData, OARS_POOL_URL: fake.origin };
    const start = 1_800_000_100_000;
    appendLine(dir, eventLine(0));
    markNoticeShown(dir, () => 0);
    expect(await sendNightly(env, 'win32', 'C:\\unused-home', () => start)).toEqual({ outcome: 'sent', sent: 1, requests: 1 });
    // The runs in between record their store-health and run-cost events; none of them is posted until the day is up.
    appendLine(dir, eventLine(1));
    expect(await sendNightly(env, 'win32', 'C:\\unused-home', () => start + 3_600_000)).toEqual({ outcome: 'not-due', sent: 0, requests: 0 });
    expect(await sendNightly(env, 'win32', 'C:\\unused-home', () => start + 86_399_999)).toEqual({ outcome: 'not-due', sent: 0, requests: 0 });
    expect(fake.received).toHaveLength(1);
    expect(readSpool(dir)).toHaveLength(1);
    expect(await sendNightly(env, 'win32', 'C:\\unused-home', () => start + 86_400_000)).toEqual({ outcome: 'sent', sent: 1, requests: 1 });
    expect(fake.received).toHaveLength(2);
  });

  it('sends nothing with telemetry off', async () => {
    const fake = await serve();
    const { appData, dir } = folder();
    appendLine(dir, eventLine(0));
    markNoticeShown(dir, () => 0);
    const result = await sendNightly({ APPDATA: appData, OARS_POOL_URL: fake.origin, OARS_TELEMETRY: '0' }, 'win32', 'C:\\unused-home', () => 0);
    expect(result.outcome).toBe('not-allowed');
    expect(fake.received).toHaveLength(0);
  });
});

const REAL_OPTIONS = Intl.DateTimeFormat().resolvedOptions();
const zoned = (timeZone: string): Intl.ResolvedDateTimeFormatOptions => ({ ...REAL_OPTIONS, timeZone });

describe('sendSpool in a closed region', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const zoneIs = (zone: string | undefined): void => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
      if (zone === undefined) throw new Error('no zone');
      return zoned(zone);
    });
  };

  it.each(['Europe/Berlin', 'Europe/London', 'Atlantic/Canary', undefined])('sends nothing from %s and keeps the spool', async (zone) => {
    const fake = await serve();
    zoneIs(zone);
    const dir = spooled(2);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toMatchObject({ outcome: 'not-allowed', requests: 0 });
    expect(fake.received).toHaveLength(0);
    expect(readSpool(dir)).toHaveLength(2);
  });

  it('sends nothing for an install that saw an older notice, then stamps the batch with the notice it saw', async () => {
    const fake = await serve();
    zoneIs('America/New_York');
    const dir = spooled(1, false);
    writeFileSync(spoolPaths(dir).settings, JSON.stringify({ noticeShownAt: '2026-11-01T00:00:00.000Z' }));
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toMatchObject({ outcome: 'not-allowed', requests: 0 });
    expect(markNoticeShown(dir, () => 0)).toBe(true);
    expect(await sendWith(dir, { OARS_POOL_URL: fake.origin })).toMatchObject({ outcome: 'sent' });
    expect(fake.received[0]?.body).toMatchObject({ notice: 2 });
  });

  it('sends from America/New_York, and the batch carries the notice version', async () => {
    const fake = await serve();
    zoneIs('America/New_York');
    expect(await sendWith(spooled(1), { OARS_POOL_URL: fake.origin })).toMatchObject({ outcome: 'sent' });
    expect(fake.received[0]?.body).toMatchObject({ notice: NOTICE_VERSION });
  });
});
