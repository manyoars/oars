// `oars sessions recall --context --write [file]`: the repository's recall block, kept between two marker lines in an instruction file, so an agent that
// reads the file sees the repository's recurring errors with oars not installed. This module is the pure part: which file, which lines survive, and the new
// file text. The command (`sessionsContextWrite` in command.ts) reads the store and the disk and does the one write.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Provenance only: where the block came from and how to refresh it. The domain is bare, and the line holds no verb that asks a reader to do anything but rerun. */
export const BEGIN = '<!-- oars recall: begin (written by "oars sessions recall --context --write", manyoars.com; rerun to refresh) -->';
export const END = '<!-- oars recall: end -->';
const DAY_LINE = /^Lines last changed: (\d{4}-\d{2}-\d{2})\.$/;
/** A marker is found by its prefix, so a block written by an older wording of the begin line still counts as the marker pair. */
const BEGIN_MARKER = /^<!-- oars recall: begin\b.*-->$/;

export const AGENTS = 'AGENTS.md';
export const CLAUDE = 'CLAUDE.md';

/** One line of a file: its text without the line ending, the ending itself, and where the line (ending included) sits. */
interface Row {
  text: string;
  eol: string;
  start: number;
  end: number;
}

const rowsOf = (file: string): Row[] =>
  [...file.matchAll(/[^\n]*\n|[^\n]+$/g)].map((match) => {
    const raw = match[0];
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    return { text: raw.slice(0, raw.length - eol.length), eol, start: match.index, end: match.index + raw.length };
  });

const isBegin = (row: Row): boolean => BEGIN_MARKER.test(row.text.trim());
const isEnd = (row: Row): boolean => row.text.trim() === END;

/** True when the file holds any marker line, a lone one included: a lone marker is refused later, and must not send the write to the other file. */
export const holdsMarker = (file: string): boolean => rowsOf(file).some((row) => isBegin(row) || isEnd(row));

/** The nearest directory at or above `start` that holds a `.git` entry (a folder, or the file a linked worktree keeps); null outside a repository. */
export const gitTop = (start: string, exists: (path: string) => boolean = existsSync): string | null => {
  for (let dir = start; ; ) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** What `--write` with no file found at the git top level: a file name, or the reason it will not write. `existing` holds each file's text, absent when it does not exist. */
export type Choice = { file: string; both: boolean } | { refusal: string };

/**
 * The default target, in the brief's order: the one file that already holds the marker pair (both: refused), else `CLAUDE.md` when it exists and `AGENTS.md`
 * does not, else `AGENTS.md`. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` sits in the working directory or above it, unless `CLAUDE.md` imports it
 * (https://code.claude.com/docs/en/memory, read 2026-11-21), so an existing `CLAUDE.md` wins over a fixed `AGENTS.md`.
 */
export const chooseFile = (existing: { [name: string]: string | undefined }): Choice => {
  const agents = existing[AGENTS];
  const claude = existing[CLAUDE];
  const both = agents !== undefined && claude !== undefined;
  const marked = [AGENTS, CLAUDE].filter((name) => holdsMarker(existing[name] ?? ''));
  if (marked.length === 2) return { refusal: `${AGENTS} and ${CLAUDE} both hold an oars recall block. Keep one, then rerun, or name the file: --write <file>.` };
  const [holder] = marked;
  if (holder !== undefined) return { file: holder, both };
  return { file: claude !== undefined && agents === undefined ? CLAUDE : AGENTS, both };
};

export const BOTH_NOTICE = `Both ${AGENTS} and ${CLAUDE} exist here. Claude Code reads ${AGENTS} only if ${CLAUDE} imports it (@${AGENTS}).`;

/** Why a file with the wrong markers is left as it is: more than one pair, or one marker alone, or the end before the begin. */
export const MARKER_REFUSAL = 'holds more than one oars recall marker pair, or one marker alone, or the end marker before the begin. Nothing was changed. Fix the markers, or delete the stray ones, then rerun.';

export interface Plan {
  /** The file text after the write; absent when nothing is to be written. */
  content?: string;
  /** True when the file does not exist yet. */
  created: boolean;
  /** True when the lines on disk already match. */
  unchanged: boolean;
  /** The block as it stands after the run (markers included), for printing. */
  block: string[];
  refusal?: string;
}

const dayOf = (inner: Row[]): string | undefined => inner.map((row) => DAY_LINE.exec(row.text)?.[1]).find((day) => day !== undefined);

/**
 * The block for `lines` and the new file text. `today` is the day the lines changed, kept from the block on disk when its lines are the same ones. With one
 * begin and one end marker only the text between them is replaced; with none the block is appended; anything else is refused.
 */
export const planWrite = (existing: string | undefined, lines: readonly string[], today: string): Plan => {
  const file = existing ?? '';
  const rows = rowsOf(file);
  const begins = rows.filter(isBegin);
  const ends = rows.filter(isEnd);
  const blockOf = (day: string): string[] => [BEGIN, ...lines, `Lines last changed: ${day}.`, END];
  if (begins.length + ends.length === 0) {
    const eol = rows.find((row) => row.eol !== '')?.eol ?? '\n';
    const lead = file === '' ? '' : `${file.endsWith('\n') ? '' : eol}${eol}`;
    const block = blockOf(today);
    return { content: `${file}${lead}${block.join(eol)}${eol}`, created: existing === undefined, unchanged: false, block };
  }
  const [begin] = begins;
  const [end] = ends;
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined || end.start < begin.end) return { created: false, unchanged: false, block: [], refusal: MARKER_REFUSAL };
  const inner = rows.filter((row) => row.start >= begin.end && row.end <= end.start);
  const onDisk = inner.filter((row) => !DAY_LINE.test(row.text) && row.text.trim() !== '').map((row) => row.text);
  if (onDisk.length === lines.length && onDisk.every((line, at) => line === lines[at])) return { created: false, unchanged: true, block: [begin.text.trim(), ...onDisk, ...(dayOf(inner) === undefined ? [] : [`Lines last changed: ${dayOf(inner) ?? ''}.`]), END] };
  const eol = begin.eol === '' ? '\n' : begin.eol;
  const body = [...lines, `Lines last changed: ${today}.`].map((line) => `${line}${eol}`).join('');
  return { content: `${file.slice(0, begin.end)}${body}${file.slice(end.start)}`, created: false, unchanged: false, block: [begin.text.trim(), ...lines, `Lines last changed: ${today}.`, END] };
};

/** Which of a block's lines to keep: a line that a redaction pass would change, that holds a term from the exclusion file, or that holds a link is dropped whole, never masked. */
export const keepLines = (lines: readonly string[], redacts: (line: string) => boolean, terms: readonly string[]): { kept: string[]; dropped: number } => {
  const kept = lines.filter((line) => !redacts(line) && !terms.some((term) => line.toLowerCase().includes(term)) && !/[a-z][a-z0-9+.-]*:\/\//i.test(line));
  return { kept, dropped: lines.length - kept.length };
};
