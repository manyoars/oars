// `oars sessions try`: recall, books, and the hook line over a throwaway store of made-up sessions, for someone with no history of their own.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Outcome } from '../cli.js';
import { sessionsBooks, sessionsContext, sessionsDeposit, sessionsRecall, type SessionsDeps } from './command.js';
import type { SessionsRuntime } from './store.js';
import { DEMO_CWD, DEMO_ERROR, writeDemoSessions } from './try-demo.js';

/** Printed once at the top and under every heading, so no line of the output can be mistaken for the reader's own history. */
export const SYNTHETIC_LABEL = 'SYNTHETIC DATA: made-up sessions bundled with oars, not your history';

/** A prefix the throwaway folder carries, so a leftover one is recognizable in the temp folder. */
export const TRY_PREFIX = 'oars-try-';

const heading = (title: string, command: string): string[] => ['', `== ${title} (${SYNTHETIC_LABEL}) ==`, `$ ${command}`];

/**
 * Builds the demo store under the OS temp folder, runs the three commands over it with the same code `oars sessions` runs, and removes the
 * folder on the way out, success or failure. The runtime is its own: it never takes the caller's store, projects folder, or other sources,
 * and no command here reaches the network or a model.
 */
export const sessionsTry = async (deps: Pick<SessionsDeps, 'now'>): Promise<Outcome> => {
  const root = await mkdtemp(join(tmpdir(), TRY_PREFIX));
  try {
    const projectsRoot = join(root, 'projects');
    await writeDemoSessions(projectsRoot);
    const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: new PassThrough(), stdout: { write: () => true } };
    const own: SessionsDeps = { sessions: runtime, install: undefined, now: deps.now };
    const deposited = await sessionsDeposit(own, { allow: [], allowFiles: [], redactDomains: [] });
    const recalled = await sessionsRecall(own, { error: DEMO_ERROR });
    const booked = await sessionsBooks(own, { by: 'class', sinceDays: undefined });
    const hooked = await sessionsContext(own, { cwd: DEMO_CWD, top: 5, maxChars: 1200 });
    const text = [
      `${SYNTHETIC_LABEL}.`,
      'oars read three invented Claude Code sessions into a throwaway store, ran the commands below over it, and deletes that store when it exits.',
      'Your own store and session folders were not read or written, and nothing left this machine.',
      ...heading('Deposit', 'oars sessions deposit'),
      deposited.text,
      ...heading('Recall', `oars sessions recall --error "${DEMO_ERROR}"`),
      recalled.text,
      ...heading('Books', 'oars sessions books --by class'),
      booked.text,
      ...heading('Hook line', `oars sessions recall --context --cwd ${DEMO_CWD}`),
      hooked.text,
      '',
      'To use oars on your own sessions: oars sessions deposit',
    ].join('\n');
    return { document: { ok: true, synthetic: true, label: SYNTHETIC_LABEL, deposit: deposited.document, recall: recalled.document, books: booked.document, hook: hooked.document }, text };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
