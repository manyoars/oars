// An invented session for the pool's tests: no real session reaches this package, not even as a fixture.
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from '../../cli/src/sessions/pool-fixture.js';
import { skeletonOf, type LanguageShareEntry, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { RepoSize } from '../../cli/src/sessions/public-vocabulary.js';
import type { Harness } from '../../cli/src/sessions/schema.js';

/** Two shell steps in one prompt. Real capture writes the shell as `shellOf` names it, which the shared fixture's frame predates. */
export const sampleSkeleton = (id: string, stack: { languages: string[]; frameworks?: string[]; size?: RepoSize | null } = { languages: ['typescript'] }, day = '2026-11-01', harness: Harness = 'claude-code', command: { program: string; sub: string | null } = { program: 'git', sub: 'push' }, harnessVersion: string | null = '2.1.314', shell = 'bash'): SessionSkeleton => {
  const framed = frame({ harness, harnessVersion, shell, day, stack: { languages: stack.languages, frameworks: stack.frameworks ?? [], size: stack.size ?? null } });
  const shellStep = (n: number) => step(n, 0, 'shell.exec', { native: harness === 'cursor' ? 'run_terminal_cmd' : 'Bash', identity: { program: command.program, sub: command.sub, flags: [] } });
  const [only] = sessionsFrom(
    store({
      sessions: [session('s1', { frame: framed, harness })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [tool('s1', 0, 'Bash', { steps: [shellStep(0)] }), tool('s1', 1, 'Bash', { steps: [shellStep(1)] })],
    }),
  );
  const built = only === undefined ? null : skeletonOf(only, id, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

/** A sample skeleton with the stack's pair evidence the wire carries: a share per language on every frame, and an `explore` bucket on every prompt. */
export const withPairs = (skeleton: SessionSkeleton, shares: LanguageShareEntry[], explore: number | null): SessionSkeleton => ({
  ...skeleton,
  transcripts: skeleton.transcripts.map((transcript) => ({
    ...transcript,
    frame: { ...transcript.frame, stack: { ...transcript.frame.stack, languageShares: shares } },
    prompts: transcript.prompts.map((held) => ({ ...held, explore, frame: { ...held.frame, stack: { ...held.frame.stack, languageShares: shares } } })),
  })),
});
