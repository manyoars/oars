// The one entry file the installed hooks and the nightly task run: `node hook-bin.js <session-start|pre-tool|post-tool|stop|nightly>`, with the
// hook event JSON on stdin. It imports only the store modules (not the CLI), so a call costs little more than the node start, and it
// always exits 0 with no output on any failure: a hook must never fail or block a session.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from './credentials.js';
import type { NightlyTelemetry } from './telemetry/health.js';
import { HOOK_EVENTS, hookRuntime, runHook, type HookEvent } from './sessions/hooks.js';

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

/** Only the nightly run records anything: the health of the store and what the run cost. The per-tool hooks stay as they were. */
const telemetryOf = (event: HookEvent): NightlyTelemetry | undefined =>
  event === 'nightly'
    ? { env: process.env, telemetry: { dir: join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'telemetry'), platform: process.platform }, version: versionOf(), now: Date.now }
    : undefined;

const eventOf = (name: string | undefined): HookEvent | undefined => HOOK_EVENTS.find((event) => event === name);

try {
  const event = eventOf(process.argv[2]);
  if (event !== undefined) {
    const output = await runHook(
      event,
      event === 'nightly' ? '' : await readStdin(),
      hookRuntime(event, process.env, process.platform, homedir(), { stdin: process.stdin, stdout: process.stdout }),
      Date.now,
      telemetryOf(event),
    );
    if (output !== undefined) process.stdout.write(output);
  }
} catch {
  // Fail-open.
}
process.exitCode = 0;
