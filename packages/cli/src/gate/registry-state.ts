// What a registry answer says about a crossing, shared by replay (as of the replay's run) and the hook (as of the moment of crossing), so the two read it the same way.
import type { Crossing } from './checks.js';
import type { AgainstLatest, RegistryAge } from './record.js';
import type { RegistryAnswer } from './registry.js';

export const DAY_MS = 86_400_000;

/** Only these managers read the registry the `npm view` and `pip index` asks reach. A `pnpm` (its own global `rc`), `poetry`, `uv`, `yarn`, or `conda` install may use one they do not. */
export const ASKED_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'npx', 'pip', 'python -m pip']);

export const ageOf = (answer: RegistryAnswer, ts: string | null): RegistryAge => {
  if (answer.created === null || ts === null) return 'unknown';
  const days = (Date.parse(ts) - Date.parse(answer.created)) / DAY_MS;
  if (Number.isNaN(days)) return 'unknown';
  if (days < 0) return 'after-crossing';
  if (days < 7) return 'under-7-days';
  if (days < 30) return 'under-30-days';
  return days < 365 ? 'under-1-year' : 'older';
};

export const againstLatestOf = (crossing: Crossing, answer: RegistryAnswer): AgainstLatest => {
  if (answer.state !== 'found') return 'unknown';
  if (crossing.versionForm === 'unstated') return 'unstated';
  if (crossing.versionForm === 'range') return 'range';
  if (crossing.version === 'latest' || crossing.version === answer.latest) return 'latest';
  return crossing.versionForm === 'pinned' ? 'not-latest' : 'unknown';
};

/** An answer reaches a row only when that row's own program was asked and its command left the registry to the default: the same name can cross twice. */
export const askedOf = (crossing: Crossing): boolean => crossing.registryAsked && crossing.form !== 'local-bin-run' && ASKED_PROGRAMS.has(crossing.program);
