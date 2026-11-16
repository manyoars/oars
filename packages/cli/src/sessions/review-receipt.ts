// `oars sessions receipt <session-id>`: a Markdown receipt of the verification commands (tests, builds, linters, type and format checks) one session ran and the result each
// showed, from the local store only. The store keeps no raw command and no output: a shell call holds `segments[].run` (the program plus its plain words, flag values included, redacted at capture), its `templates`, and a status.
// Flag values stay in `run` as plain words, so `scrub` and the secret-flag rule are the gate that matters, not the store. A person pastes the receipt into a review by hand; nothing is sent and nothing maps the session to a pull request.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Outcome } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import type { SessionsDeps } from './command.js';
import { HARNESS_ERROR_CLASSES, harnessOf, type SessionObservation, type ShellSegment, type ToolObservation } from './schema.js';
import { loadStore, type Store } from './store.js';

// A `segments[].run` is the program and its plain words, so `python -m pytest` is `python pytest` and `npx vitest run <file>` is `npx vitest run`.
const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn|python3?|py|uv\s+run|poetry\s+run)\s+)?`;
// A workspace form (`npm -w web test`) is stored as `npm web test`; the lookahead keeps `npm install test` out.
const SCRIPT = String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:(?!(?:add|i|install|uninstall|remove|rm|link|view|get|run)\s)\S+\s+)?`;

/**
 * The commands a receipt lists, by family: each pattern is read against one command's `run` from its first word, so a flag is never in it. A formatter lists only when the
 * call shows its check flag (`FORMAT_CHECK_FLAG`), because `prettier` and `cargo fmt` also rewrite files. Anything else is counted, not listed.
 */
export const VERIFICATION_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'test', pattern: new RegExp(`^(?:${SCRIPT}test(?::\\S+)?|${RUNNER}(?:vitest|jest|pytest|mocha)|go\\s+test|cargo\\s+(?:test|nextest)|dotnet\\s+test|mvn|mvnw|gradle|gradlew|just\\s+(?:test|check)|make\\s+(?:test|check))(?:\\s|$)`) },
  { family: 'build', pattern: new RegExp(`^(?:${SCRIPT}build(?::\\S+)?|go\\s+build|cargo\\s+build|dotnet\\s+build|just\\s+build|make\\s+build)(?:\\s|$)`) },
  { family: 'lint', pattern: new RegExp(`^(?:${SCRIPT}lint(?::\\S+)?|${RUNNER}(?:eslint|ruff(?!\\s+format)(?:\\s+check)?|flake8|golangci-lint)|cargo\\s+clippy|(?:just|make)\\s+lint)(?:\\s|$)`) },
  { family: 'type check', pattern: new RegExp(`^(?:${SCRIPT}(?:typecheck|check)|${RUNNER}(?:tsc|mypy|pyright))(?:\\s|$)`) },
  { family: 'format check', pattern: new RegExp(`^(?:${RUNNER}(?:prettier|ruff\\s+format|black)|cargo\\s+fmt)(?:\\s|$)`) },
];

/** The check flag a formatter's template keeps (`prettier --check <ident>`). A flag capture does not know shows as `<flag>`, so it is never seen here. */
export const FORMAT_CHECK_FLAG = /(?:^|\s)(--check|--list-different)(?:\s|$)/;

/** The family of one command's `run`; a formatter counts only when `checked` (its template shows a check flag). */
export const familyOf = (run: string, checked = true): string | undefined => {
  const family = VERIFICATION_FAMILIES.find((entry) => entry.pattern.test(run))?.family;
  return family === 'format check' && !checked ? undefined : family;
};

const COMMAND_CHARS = 120;
// Capture keeps a flag's value in `run` as a plain word. A template shows a known flag by name and any other flag as `<flag>`, so a secret flag name or a hidden one means the value must not print.
const SECRET_TEMPLATE = /(?:^|\s)(?:--?(?:token|password|passwd|secret|api-?key|auth|authorization|credentials?)\b|-p)(?:[\s=]|$)|<flag>/i;
const SECRET_FLAG = /\s+(?:--?(?:token|password|passwd|secret|api-?key|auth|authorization|credentials?)\b|-p\s)[\s\S]*$/i;
const ASSIGNMENT = /\s+[A-Za-z_][A-Za-z0-9_]*=[\s\S]*$/;
const LEADING_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
// Anchored to a word start, so `src/a.ts` and `https://x` keep their slashes.
const ABSOLUTE_PATH = /(?<=^|\s)(?:[A-Za-z]:[\\/]|~[\\/]|\/(?=[^\s/]))\S*/g;

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

const HARNESS_ERRORS: ReadonlySet<string> = new Set<string>(HARNESS_ERROR_CLASSES);
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
  /** Commands (not calls) that are not listed: `npm test && git push` adds one. */
  other: number;
}

/**
 * What the session observed for one command of a call. `not recorded` where the store cannot say: a Codex session (the Codex reader loses shell outcomes on 0.166 and later,
 * and the other versions are not told apart here), a call with no result, a call the harness refused or cut off (its `errorCode` is a harness class, so no exit result exists), or a command a pipe or a later command hides from the call's status. Never `exit 0` from a guess.
 */
export const resultOf = (call: ToolObservation, index: number, codex: boolean): string => {
  if (codex || call.status === 'none' || (call.errorCode !== undefined && HARNESS_ERRORS.has(call.errorCode))) return 'not recorded';
  const read = call.segments?.[index]?.read ?? (call.templates?.length === 1);
  if (!read) return 'not recorded';
  if (call.status === 'ok') return 'exit 0';
  // A failed chain (`a && b`) has one status for every command, so which one failed is not stored.
  if ((call.segments ?? []).filter((segment) => segment.read).length > 1) return 'not recorded';
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

/** Only the part of a command a family pattern names (`pytest` of `pytest hunter2 tests`), for a command whose flag values may be secret. */
const programOf = (run: string): string => VERIFICATION_FAMILIES.map((entry) => entry.pattern.exec(run)?.[0].trim()).find((match) => match !== undefined) ?? run.split(' ')[0] ?? '';

/** A call's commands: its segments, else (a call captured before segments) its templates as words, readable only when the call holds one command. */
const segmentsOf = (call: ToolObservation): ShellSegment[] => call.segments ?? (call.templates ?? []).map((run, _index, all) => ({ run, read: all.length === 1 }));

export const reviewReceiptOf = (store: Store, session: SessionObservation, home: string = homedir()): ReviewReceipt => {
  const codex = harnessOf(session) === 'codex';
  // Sidechain lines are subagent work: the Scope line says they are not included.
  const calls = store.tools.filter((call) => call.session === session.session && !call.side).sort((a, b) => a.n - b.n);
  const rows: ReceiptRow[] = [];
  let other = 0;
  for (const [position, call] of calls.entries()) {
    const templates = call.templates ?? [];
    for (const [index, segment] of segmentsOf(call).entries()) {
      // A template lines up with a segment only when the call keeps one of each.
      const flag = templates.length === call.segments?.length ? FORMAT_CHECK_FLAG.exec(templates[index] ?? '')?.[1] : undefined;
      // The template that lines up with this segment, else any template of the call, decides whether a secret flag was on the line.
      const secret = (templates.length === call.segments?.length ? [templates[index] ?? ''] : templates).some((template) => SECRET_TEMPLATE.test(template));
      const scrubbed = scrub(segment.run, home);
      const run = secret ? programOf(scrubbed) : scrubbed;
      // The ellipsis of a cut command is not part of the command that runs.
      const family = familyOf(run.replace(/…$/, ''), flag !== undefined);
      if (family === undefined) {
        other += 1;
        continue;
      }
      rows.push({ order: position + 1, family, command: family === 'format check' && flag !== undefined ? `${run} ${flag}` : run, result: resultOf(call, index, codex) });
    }
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

/** The five most recent sessions, newest first by their first timestamp, with the date only: no prompt text. */
export const recentSessions = (store: Store): Array<{ session: string; date: string }> =>
  main(store)
    .map((session) => ({ session: session.session, first: session.tsFirst ?? '' }))
    // A session with no timestamp sorts after every dated one.
    .sort((a, b) => Number(a.first === '') - Number(b.first === '') || b.first.localeCompare(a.first) || a.session.localeCompare(b.session))
    .slice(0, 5)
    .map((entry) => ({ session: entry.session, date: entry.first === '' ? 'no date' : entry.first.slice(0, 10) }));

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
