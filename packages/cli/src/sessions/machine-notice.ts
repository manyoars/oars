// The notice file of a machine: the one way the detached child tells the person anything. A child prints to nowhere (its output is redirected, and its Stop has long returned), so a condition the person has to act on is written here, and the
// next Stop reads the file before it starts its own child and prints it once, as the hook's `systemMessage`. The file is `<store>/machine-notice.json`, `{"entries":[{"code":"vocabulary_expired","at":<ms>}]}`, one entry per code
// (a repeat replaces its entry, so a condition that holds at every Stop is one line, not a pile). `vocabulary_expired` is the first code: a client past its vocabulary's age builds no batch, and its sessions wait.
// The reader runs inside the Stop hook, so it is synchronous and reads only this one small file.
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';

export const NOTICE_CODES = ['vocabulary_expired', 'hold_unconfigured', 'machine_key_expiring', 'machine_key_expired', 'machine_key_revoked'] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

export interface NoticeEntry {
  code: NoticeCode;
  /** Epoch milliseconds when the child wrote it. */
  at: number;
  /** Epoch milliseconds the machine key expires, kept for `machine_key_expiring` so the message can name the day. */
  expiresAt?: number;
}

const NOTICE = 'machine-notice.json';
// When each code was last written: the notice file is cleared when a Stop prints it, so the cap needs a record that outlives it.
const WRITTEN = 'machine-notified.json';
/** A code is written at most this often, so an expired client prints its message once a day, not at every Stop. */
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const noticeFile = (storeDir: string): string => join(storeDir, NOTICE);

/** What the person is told for each code: what stopped, what is kept, and the one step. */
const LIST = 'oars pool machines lists the machines of your account, their expiry included.';
const TEXT: { [code in NoticeCode]: (entry: NoticeEntry) => string } = {
  hold_unconfigured: () => 'oars on this machine holds nothing: OARS_MACHINE or OARS_SESSION_SALT is missing from its enrollment, so no session reaches its hold branch and the data of its sessions is lost. Run oars pool enroll --hold-only on your own machine and set the printed block in this environment.',
  vocabulary_expired: () => 'oars on this machine is out of date, so it builds no deposit batches: its closed vocabulary is past its age limit. The sessions stay on this machine. Upgrade with npm install -g @manyoars/oars.',
  machine_key_expiring: (entry) => `The pool key of this machine expires ${entry.expiresAt === undefined ? 'soon' : `on ${new Date(entry.expiresAt).toISOString().slice(0, 10)}`}; after that its deposits are refused. ${LIST} Enroll the machine again with oars pool enroll before then.`,
  machine_key_expired: () => `The pool key of this machine has expired, so its deposits are refused and its batches wait in its outbox. ${LIST} Enroll the machine again with oars pool enroll.`,
  machine_key_revoked: () => 'The account revoked the pool key of this machine, so its deposits are refused and its batches wait in its outbox. See oars pool machines; enroll this machine again with oars pool enroll if the revocation was a mistake.',
};

const isCode = (value: unknown): value is NoticeCode => NOTICE_CODES.some((code) => code === value);

/** The entries in `text`, those with a known code and a numeric time; anything else in the file (a newer client's code, a damaged line) is dropped. */
const entriesOf = (text: string): NoticeEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const listed: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'entries') : undefined;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown) => {
    const code: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'code') : undefined;
    const at: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'at') : undefined;
    const expiresAt: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'expiresAt') : undefined;
    return isCode(code) && typeof at === 'number' ? [{ code, at, ...(typeof expiresAt === 'number' ? { expiresAt } : {}) }] : [];
  });
};


/** The child records a condition: its entry replaces an earlier one of the same code and keeps its place, so the file lists the codes in the order they were first raised. A notice file it cannot read is rewritten. */
export const recordNotice = async (storeDir: string, code: NoticeCode, at: number, expiresAt?: number): Promise<void> => {
  const written = entriesOf(await readFile(join(storeDir, WRITTEN), 'utf8').catch(() => ''));
  const last = written.find((entry) => entry.code === code);
  // A clock that moved backward (`at < last.at`) writes again, rather than staying quiet until it catches up.
  if (last !== undefined && at >= last.at && at - last.at < NOTICE_INTERVAL_MS) return;
  const kept = entriesOf(await readFile(noticeFile(storeDir), 'utf8').catch(() => ''));
  // A Map keeps a key's first place when it is set again.
  const byCode = new Map(kept.map((entry) => [entry.code, entry]));
  byCode.set(code, { code, at, ...(expiresAt === undefined ? {} : { expiresAt }) });
  const entries = [...byCode.values()];
  await mkdirOwnerOnly(storeDir);
  await writeOwnerOnly(noticeFile(storeDir), `${JSON.stringify({ entries })}\n`);
  await writeOwnerOnly(join(storeDir, WRITTEN), `${JSON.stringify({ entries: [...written.filter((entry) => entry.code !== code), { code, at }] })}\n`);
};

/** The one message for a set of entries, or `undefined` for none. */
export const messageOf = (entries: readonly NoticeEntry[]): string | undefined => (entries.length === 0 ? undefined : entries.map((entry) => TEXT[entry.code](entry)).join(' '));

/**
 * The Stop reads the notice and clears it: the file is renamed first, so two Stops never both print it, then read and removed. The text, or `undefined` when there is no notice. Never throws: a hook that cannot read its notice goes on to
 * start its child, and the condition, still true, is written again by that child.
 */
export const takeNotice = (storeDir: string): string | undefined => {
  const taken = `${noticeFile(storeDir)}.${String(process.pid)}`;
  try {
    renameSync(noticeFile(storeDir), taken);
  } catch {
    return undefined;
  }
  try {
    return messageOf(entriesOf(readFileSync(taken, 'utf8')));
  } catch {
    return undefined;
  } finally {
    rmSync(taken, { force: true });
  }
};
