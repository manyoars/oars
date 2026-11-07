// What `oars gate hook` tells telemetry about one fire: the fire itself, plus the harness version and model its transcript states. Apart from `hook-main.ts` so a test drives the same line the process runs.
import { statedAt } from '../sessions/transcript-tail.js';
import type { Emit } from '../telemetry/emit.js';
import { frameWords } from '../telemetry/fields.js';
import type { HookProcess } from './hook-process.js';

/** `oars gate hook` is the Claude Code hook the gate installs. */
const HOOK_HARNESS = 'claude-code';

export const fireRecorder = (emit: Emit): NonNullable<HookProcess['record']> =>
  async (fire, transcript) => {
    // No await before this on the deadline path (no transcript), so that fire is written before the timer's `exit`.
    const stated = transcript === undefined ? undefined : await statedAt(transcript);
    emit('hook', { name: 'gate', ...fire, ...frameWords(HOOK_HARNESS, stated?.harnessVersion, stated?.model) });
  };
