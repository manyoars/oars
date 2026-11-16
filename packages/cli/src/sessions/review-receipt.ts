// `oars sessions receipt <session-id>`: a Markdown receipt of the verification commands (tests, builds, linters, type and format checks) one session ran and the result each
// showed, from the local store only. The store keeps no raw command and no output: a shell call holds its command templates (program, subcommand, flags, every other word a
// slot) and a status, so nothing here can carry a prompt, a path, or a secret. `scrub` still runs over every command as a second gate. A person pastes the receipt into a
// review by hand; nothing is sent and nothing maps the session to a pull request.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import type { SessionsDeps } from './command.js';
import { harnessOf, type SessionObservation, type ToolObservation } from './schema.js';
import { loadStore, type Store } from './store.js';

const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn|python3?\s+-m|uv\s+run|poetry\s+run)\s+)?`;
const SCRIPT = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?`;

/** The commands a receipt lists, by family: each pattern is read against one command template from its first word. Anything else is counted, not listed. */
export const VERIFICATION_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'test', pattern: new RegExp(`^(?:${SCRIPT}test(?::\\S+)?|${RUNNER}(?:vitest|jest|pytest|mocha)|go\\s+test|cargo\\s+(?:test|nextest)|dotnet\\s+test|mvn|gradle|gradlew|just\\s+(?:test|check))(?:\\s|$)`) },
  { family: 'build', pattern: new RegExp(`^(?:${SCRIPT}build(?::\\S+)?|go\\s+build|cargo\\s+build|dotnet\\s+build|just\\s+build)(?:\\s|$)`) },
  { family: 'lint', pattern: new RegExp(`^(?:${SCRIPT}lint(?::\\S+)?|${RUNNER}(?:eslint|ruff(?:\\s+check)?|flake8|golangci-lint)|cargo\\s+clippy)(?:\\s|$)`) },
  { family: 'type check', pattern: new RegExp(`^(?:${SCRIPT}(?:typecheck|check)|${RUNNER}(?:tsc|mypy|pyright))(?:\\s|$)`) },
  { family: 'format check', pattern: new RegExp(`^(?:${RUNNER}(?:prettier|ruff\\s+format|black)\\s+[^\\n]*(?:--check|-c|--list-different)|cargo\\s+fmt\\s+[^\\n]*--check|gofmt\\s+-l)(?:\\s|$)`) },
];

export const familyOf = (command: string): string | undefined => VERIFICATION_FAMILIES.find((entry) => entry.pattern.test(command))?.family;

const COMMAND_CHARS = 120;
const SECRET_FLAG = /\s+(?:--?(?:token|password|passwd|secret|api-?key|auth|authorization|credentials?)\b|-p\s)[\s\S]*$/i;
const ASSIGNMENT = /\s+[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/;
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|~[\\/]|\/(?=[^\s/]))[^\s]*/g;

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** One command as the receipt prints it: its first line, no environment assignment or secret flag with what follows, every home or absolute path `<path>`, cut to a fixed length. */
export const scrub = (command: string, home: string = homedir()): string => {
  const lines = command.split(/\r?\n/);
  let text = (lines[0] ?? '').trim();
  const home1 = home.replaceAll('\\', '/');
  for (const form of [home, home1]) if (form.length > 1) text = text.replaceAll(new RegExp(`${escaped(form)}\\S*`, 'g'), '<path>');
  text = text.replace(LEADING_ASSIGNMENTS, '').replace(SECRET_FLAG, '').replace(ASSIGNMENT, '').replace(ABSOLUTE_PATH, '<path>');
  if (text.length > COMMAND_CHARS) text = `${text.slice(0, COMMAND_CHARS)}…`;
  return lines.length > 1 ? `${text}…` : text;
};

const EXIT_CLASSES_SHOWN: ReadonlySet<string> = new Set(['1', '2', '126', '127']);

export interface ReceiptRow {
  /** The call's place among all of the session's tool calls, from 1. */
  order: number;
  family: string;
  command: string;
  result: string;
}

export interface ReviewReceipt {
  session: string;
  date: string | null;
  harness: string;
  model: string | null;
  calls: number;
  rows: ReceiptRow[];
  /** Shell calls with no listed verification command in them. */
  other: number;
}

/**
 * What the session observed for one command of a call. `not recorded` where the store cannot say: a Codex session (the Codex reader loses shell outcomes on 0.166 and later,
 * and the other versions are not told apart here), a call with no result, or a command a pipe or a later command hides from the call's status. Never `exit 0` from a guess.
 */
export const resultOf = (call: ToolObservation, index: number, codex: boolean): string => {
  if (codex || call.status === 'none') return 'not recorded';
  const read = call.segments?.[index]?.read ?? (call.templates?.length === 1);
  if (!read) return 'not recorded';
  if (call.status === 'ok') return 'exit 0';
  return call.errorCode !== undefined && EXIT_CLASSES_SHOWN.has(call.errorCode) ? `exit ${call.errorCode}` : 'failed';
};

const modelOf = (session: SessionObservation): string | null =>
  Object.entries(session.models).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

const main = (store: Store): SessionObservation[] => store.sessions.filter((session) => session.supersededBy === undefined);

/** The session a reference names: its exact id, else the one session whose id starts with it. */
export const resolveSession = (store: Store, ref: string): SessionObservation | undefined => {
  const sessions = main(store);
  const exact = sessions.find((session) => session.session === ref);
  if (exact !== undefined) return exact;
  const starts = sessions.filter((session) => session.session.startsWith(ref));
  return ref.length > 0 && starts.length === 1 ? starts[0] : undefined;
};

export const reviewReceiptOf = (store: Store, session: SessionObservation, home: string = homedir()): ReviewReceipt => {
  const codex = harnessOf(session) === 'codex';
  const calls = store.tools.filter((call) => call.session === session.session).sort((a, b) => a.n - b.n);
  const rows: ReceiptRow[] = [];
  let other = 0;
  for (const [position, call] of calls.entries()) {
    const templates = call.templates ?? [];
    let listed = false;
    for (const [index, template] of templates.entries()) {
      const command = scrub(template, home);
      // The ellipsis of a cut command is not part of the command that runs.
      const family = familyOf(command.replace(/…$/, ''));
      if (family === undefined) continue;
      listed = true;
      rows.push({ order: position + 1, family, command, result: resultOf(call, index, codex) });
    }
    if (!listed && templates.length > 0) other += 1;
  }
  return { session: session.session, date: session.tsFirst?.slice(0, 10) ?? null, harness: harnessOf(session), model: modelOf(session), calls: calls.length, rows, other };
};

const cell = (text: string): string => text.replaceAll('|', String.raw`\|`).replaceAll('`', "'");

export const reviewReceiptText = (receipt: ReviewReceipt, version: string): string => {
  const counts = (result: string): number => receipt.rows.filter((row) => row.result === result).length;
  const exits = [...new Set(receipt.rows.map((row) => row.result))].sort();
  const totals = `${String(receipt.rows.length)} verification ${receipt.rows.length === 1 ? 'command' : 'commands'}${receipt.rows.length === 0 ? '' : ` (${exits.map((result) => `${String(counts(result))} ${result}`).join(', ')})`}; ${String(receipt.other)} other ${receipt.other === 1 ? 'command' : 'commands'} not shown.`;
  return [
    '# Review receipt: verification commands one session ran',
    '',
    `- Session date: ${receipt.date ?? 'not recorded'}`,
    `- Harness: ${receipt.harness}`,
    `- Model: ${receipt.model ?? 'not recorded'}`,
    `- Scope: one session's own tool calls (${String(receipt.calls)} in all); commands run in its subagents are not included.`,
    '',
    ...(receipt.rows.length === 0
      ? ['No verification commands recorded.']
      : ['| Command | Result | Call # |', '| --- | --- | --- |', ...receipt.rows.map((row) => `| \`${cell(row.command)}\` | ${row.result} | ${String(row.order)} |`)]),
    '',
    totals,
    '',
    '---',
    "What this is: commands the session ran and the results it observed on the author's machine. It is not proof the change is correct, and it maps to no pull request. Made locally by oars: `oars sessions receipt`  |  oars " + version,
    '',
  ].join('\n').trimEnd();
};

/** The five most recent sessions, newest first, by id and date: no prompt text. */
export const recentSessions = (store: Store): Array<{ session: string; date: string }> =>
  main(store)
    .map((session) => ({ session: session.session, date: session.tsFirst?.slice(0, 10) ?? 'no date' }))
    // A session with no date sorts after every dated one.
    .sort((a, b) => Number(a.date === 'no date') - Number(b.date === 'no date') || b.date.localeCompare(a.date) || a.session.localeCompare(b.session))
    .slice(0, 5);

export const sessionsReviewReceipt = async (deps: SessionsDeps, options: { session: string | undefined; out: string | undefined; version: string }): Promise<Outcome> => {
  if (deps.sessions === undefined) throw new CliError('The session store is not configured in this run.', ExitCode.UNEXPECTED, 'unexpected');
  const store = await loadStore(deps.sessions.storeDir);
  if (options.session === undefined) {
    const recent = recentSessions(store);
    const text = ['Usage: oars sessions receipt <session-id> [--out <file>]', recent.length === 0 ? 'No sessions in the local store yet.' : 'Most recent sessions:', ...recent.map((entry) => `  ${entry.session}  ${entry.date}`)].join('\n');
    return { document: { ok: true, sessions: recent }, text };
  }
  const session = resolveSession(store, options.session);
  if (session === undefined) throw new CliError(`No session ${options.session} in the local store.`, ExitCode.INVALID, 'invalid');
  const receipt = reviewReceiptOf(store, session);
  const text = reviewReceiptText(receipt, options.version);
  if (options.out === undefined) return { document: { ok: true, receipt }, text };
  const file = resolve(options.out);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${text}\n`);
  return { document: { ok: true, out: file, receipt }, text: `Wrote ${file}` };
};
