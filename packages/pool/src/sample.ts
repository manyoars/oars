// An invented session for the pool's tests: no real session reaches this package, not even as a fixture.
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { RepoSize } from '../../cli/src/sessions/public-vocabulary.js';
import type { Harness } from '../../cli/src/sessions/schema.js';

/** Two shell steps in one prompt. Real capture writes the shell as `shellOf` names it, which the shared fixture's frame predates. */
export const sampleSkeleton = (id: string, stack: { languages: string[]; frameworks?: string[]; size?: RepoSize | null } = { languages: ['typescript'] }, day = '2026-11-01', harness: Harness = 'claude-code', command: { program: string; sub: string | null } = { program: 'git', sub: 'push' }, harnessVersion = '2.1.314'): SessionSkeleton => {
  const framed = frame({ harness, harnessVersion, shell: 'bash', day, stack: { languages: stack.languages, frameworks: stack.frameworks ?? [], size: stack.size ?? null } });
  const shell = (n: number) => step(n, 0, 'shell.exec', { native: harness === 'cursor' ? 'run_terminal_cmd' : 'Bash', identity: { program: command.program, sub: command.sub, flags: [] } });
  const [only] = sessionsFrom(
    store({
      sessions: [session('s1', { frame: framed, harness })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [tool('s1', 0, 'Bash', { steps: [shell(0)] }), tool('s1', 1, 'Bash', { steps: [shell(1)] })],
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};
