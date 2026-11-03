// An invented session for the pool's tests: no real session reaches this package, not even as a fixture.
import { frame, prompt, session, step, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { sessionsOf, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';

/** Two shell steps in one prompt. Real capture writes the shell as `shellOf` names it, which the shared fixture's frame predates. */
export const sampleSkeleton = (id: string, stack: { languages: string[] } = { languages: ['typescript'] }): SessionSkeleton => {
  const framed = frame({ shell: 'bash', stack: { languages: stack.languages, frameworks: [], size: null } });
  const shell = (n: number) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } });
  const [only] = sessionsOf(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [tool('s1', 0, 'Bash', { steps: [shell(0)] }), tool('s1', 1, 'Bash', { steps: [shell(1)] })],
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id);
  if (built === null) throw new Error('no skeleton');
  return built;
};
