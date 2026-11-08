// The one entry file the installed hooks and the nightly task run: `node hook-bin.js <session-start|pre-tool|post-tool|stop|nightly>`, with the
// hook event JSON on stdin. It imports only the store modules (not the CLI), so a call costs little more than the node start, and it
// always exits 0 with no output on any failure: a hook must never fail or block a session.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hookEmitter } from './telemetry/hook-emit.js';
import { sendNightly } from './telemetry/send.js';
import { HOOK_EVENTS, hookRuntime, nightlyTelemetry, runHook, type HookEvent } from './sessions/hooks.js';

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/** The version in this package's package.json (one folder up from dist/), or `0.0.0` when it cannot be read. */
const versionOf = (): string => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/** After the covenant is accepted, the nightly task sends what the pool outbox holds; with no server, sign-in, or acceptance it sends nothing. Loaded only here so the per-tool hooks never pay for it. It never throws. */
const nightlyPool = async (event: HookEvent): Promise<void> => {
  const { nightlyPoolDeps } = await import('./sessions/pool-nightly-deps.js');
  const { nightlyPoolSend } = await import('./sessions/pool-nightly.js');
  await nightlyPoolSend(nightlyPoolDeps(process.env, hookRuntime(event, process.env, process.platform, homedir(), { stdin: process.stdin, stdout: process.stdout }), versionOf(), Date.now));
};

const eventOf = (name: string | undefined): HookEvent | undefined => HOOK_EVENTS.find((event) => event === name);

try {
  const event = eventOf(process.argv[2]);
  if (event !== undefined) {
    const output = await runHook(
      event,
      event === 'nightly' ? '' : await readStdin(),
      hookRuntime(event, process.env, process.platform, homedir(), { stdin: process.stdin, stdout: process.stdout }),
      Date.now,
      nightlyTelemetry(event, process.env, process.platform, homedir(), versionOf, Date.now),
      hookEmitter(process.env, process.platform, homedir(), new URL('../package.json', import.meta.url), Date.now),
    );
    if (output !== undefined) process.stdout.write(output);
    // The session just ended and its deposit is written: start a due sweep and send, detached, and do not wait for it (the hook stays sub-second and prints nothing more). Loaded only here so the per-tool hooks never pay for it.
    if (event === 'stop') {
      const { catchUpOnStore } = await import('./sessions/pool-due.js');
      await catchUpOnStore(hookRuntime(event, process.env, process.platform, homedir(), { stdin: process.stdin, stdout: process.stdout }).storeDir, fileURLToPath(import.meta.url));
    }
    // The nightly task is where telemetry is sent from; it never throws, and it sends nothing unless telemetry is on and the notice was shown (the server is OARS_POOL_URL, else the Many Oars pool).
    if (event === 'nightly') {
      await sendNightly(process.env, process.platform, homedir(), Date.now);
      await nightlyPool(event);
    }
  }
} catch {
  // Fail-open.
}
process.exitCode = 0;
