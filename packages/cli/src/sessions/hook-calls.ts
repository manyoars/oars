// The hook counters: `hook-calls.jsonl`, one line per hook invocation, appended by the hook and read by `measure`.
import { appendFile, readFile } from 'node:fs/promises';
import { mkdirOwnerOnly } from './owner-only.js';
import { paths } from './store.js';
import type { HookCall } from './schema.js';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const eventOf = (value: unknown): HookCall['event'] | undefined => {
  if (value === 'session-start' || value === 'prompt' || value === 'pre-tool' || value === 'post-tool' || value === 'stop' || value === 'nightly' || value === 'codex-record') return value;
  return undefined;
};

export const appendHookCall = async (storeDir: string, call: HookCall): Promise<void> => {
  await mkdirOwnerOnly(storeDir);
  await appendFile(paths(storeDir).hookCalls, `${JSON.stringify(call)}\n`, { mode: 0o600 });
};

export const readHookCalls = async (storeDir: string): Promise<HookCall[]> => {
  let text = '';
  try {
    text = await readFile(paths(storeDir).hookCalls, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const calls: HookCall[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const event = isRecord(parsed) ? eventOf(parsed.event) : undefined;
      if (isRecord(parsed) && event !== undefined && typeof parsed.at === 'string' && typeof parsed.hit === 'boolean' && typeof parsed.ms === 'number') {
        calls.push({
          at: parsed.at,
          event,
          session: typeof parsed.session === 'string' ? parsed.session : null,
          hit: parsed.hit,
          ms: parsed.ms,
          ...(typeof parsed.startMs === 'number' ? { startMs: parsed.startMs } : {}),
          error: typeof parsed.error === 'string' ? parsed.error : null,
        });
      }
    } catch {
      // A torn last line is skipped.
    }
  }
  return calls;
};
