// `oars card --week --text`: a short plain-text receipt of the person's own last seven local days, from the local store only. Every line is a count whose rule
// is one sentence over recorded fields, and nothing printed can be traced to a path, a repository, a prompt, or a tool or model name: the only names are the
// closed harness list. Display only; what the store collects and keeps is not touched here.
import { harnessOf, type Harness, type SessionObservation } from './schema.js';
import type { Store } from './store.js';

export const WEEK_DAYS = 7;

// wording: owner read pending (no field-definition URL until the owner gives the footer wording and the page exists)
export const WEEK_FOOTER = 'oars card --week --text';

export interface WeekReceipt {
  /** The first local date of the window (YYYY-MM-DD). */
  start: string;
  /** The local date the window ends on: today. */
  end: string;
  sessions: number;
  activeDays: number;
  harnesses: Array<{ name: Harness; sessions: number }>;
  /** Whether a Codex session is in the window: the Codex reader loses shell outcomes on Codex 0.166 and later, so outcome lines leave those sessions out. */
  codex: boolean;
  /** Tool calls whose first result was an error, in sessions that are not Codex; null when no such session is in the window. */
  failedCalls: number | null;
  /** Of the prompts that edited something (a runner recorded, verify not `na`) in a session that is not Codex, how many ended with a build or test runner that passed; null when none edited. */
  passingRuns: { passed: number; of: number } | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (date: Date): string => `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const weekOf = (store: Store, now: number): WeekReceipt => {
  const today = new Date(now);
  // Local calendar days: the window opens at local midnight six days before today and closes at the next local midnight.
  const opens = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (WEEK_DAYS - 1)).getTime();
  const closes = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  const prompts = store.prompts.filter((prompt) => prompt.ts !== null && Date.parse(prompt.ts) >= opens && Date.parse(prompt.ts) < closes);
  const ids = new Set(prompts.map((prompt) => prompt.session));
  const sessions: SessionObservation[] = store.sessions.filter((session) => ids.has(session.session) && session.supersededBy === undefined);
  const codexIds = new Set(sessions.filter((session) => harnessOf(session) === 'codex').map((session) => session.session));
  const counts = new Map<Harness, number>();
  for (const session of sessions) counts.set(harnessOf(session), (counts.get(harnessOf(session)) ?? 0) + 1);
  const keys = new Set(prompts.filter((prompt) => !codexIds.has(prompt.session)).map((prompt) => `${prompt.session}#${String(prompt.index)}`));
  // A replayed result keeps its line beside the first (schema.ts), so a call with a tool use id counts once per (session, id).
  const failed = new Set<string>();
  let anonymous = 0;
  for (const error of store.errors) {
    if (error.agent !== undefined || error.prompt === null || !keys.has(`${error.session}#${String(error.prompt)}`)) continue;
    if (error.toolUseId === undefined || error.toolUseId === null) anonymous += 1;
    else failed.add(`${error.session}#${error.toolUseId}`);
  }
  const edited = prompts.filter((prompt) => !codexIds.has(prompt.session) && prompt.verify !== undefined && prompt.verify !== 'na');
  return {
    start: localDate(new Date(opens)),
    end: localDate(today),
    sessions: sessions.length,
    activeDays: new Set(prompts.map((prompt) => localDate(new Date(prompt.ts ?? '')))).size,
    harnesses: [...counts.entries()].map(([name, count]) => ({ name, sessions: count })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
    codex: codexIds.size > 0,
    failedCalls: keys.size === 0 ? null : failed.size + anonymous,
    passingRuns: edited.length === 0 ? null : { passed: edited.filter((prompt) => prompt.verify === 'passed').length, of: edited.length },
  };
};

const LABEL = 15;
const WIDTH = 80;
const row = (label: string, value: string): string => `${label.padEnd(LABEL)}${value}`;

/** The harness list wrapped onto continuation lines indented to the label, so no line passes 80 columns. */
const harnessRows = (week: WeekReceipt): string[] => {
  const lines: string[] = [];
  let current = '';
  for (const [index, entry] of week.harnesses.entries()) {
    const piece = `${entry.name} ${String(entry.sessions)}${index === week.harnesses.length - 1 ? '' : ','}`;
    if (current !== '' && LABEL + current.length + 1 + piece.length > WIDTH) {
      lines.push(current);
      current = piece;
    } else current = current === '' ? piece : `${current} ${piece}`;
  }
  lines.push(current);
  return lines.map((line, index) => (index === 0 ? row('harnesses', line) : row('', line)));
};

/** The receipt: at most twelve lines, none over 80 columns, no color. */
export const weekText = (week: WeekReceipt, version: string): string => {
  const outcomes = week.failedCalls !== null || week.passingRuns !== null;
  const head = `oars week: ${week.start} to ${week.end} (${String(WEEK_DAYS)} local days)`;
  const foot = `${WEEK_FOOTER}  |  oars ${version}`;
  if (week.sessions === 0) return [head, 'no sessions in this window in the local store', foot].join('\n');
  return [
    head,
    row('sessions', `${String(week.sessions)} on ${String(week.activeDays)} active ${week.activeDays === 1 ? 'day' : 'days'}`),
    ...harnessRows(week),
    ...(week.codex && week.failedCalls === null && week.passingRuns === null ? [row('outcomes', 'Codex sessions not counted')] : []),
    ...(week.failedCalls === null ? [] : [row('failed calls', String(week.failedCalls))]),
    ...(week.passingRuns === null ? [] : [row('passing runs', `${String(week.passingRuns.passed)} of ${String(week.passingRuns.of)} edited prompts with a runner recorded`)]),
    ...(week.codex && outcomes ? [row('', '(Codex sessions not counted)')] : []),
    foot,
  ].join('\n');
};
