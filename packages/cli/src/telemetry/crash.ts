// A crash report is the error's class and a hash of its stack: never its message, which can hold a path. The stack's own text is read only to be
// hashed, and every file path in it is reduced to its place inside a package (or hashed whole when it sits nowhere known) before that, so the same
// code on two machines is the same crash and no home folder reaches the hash's input in clear.
import { createHash } from 'node:crypto';
import { emitEvent, type Emitter } from './emit.js';
import { CRASH_CLASSES, type CrashClass } from './schema.js';

/** The class of a thrown value: a built-in error class by name, else `other`. A class a program or library defines, and a name set to text, are `other`. */
export const crashClassOf = (error: unknown): CrashClass => {
  if (!(error instanceof Error)) return 'other';
  // A subclass of a built-in is that built-in; walk up until one is named.
  for (let proto: unknown = Object.getPrototypeOf(error); typeof proto === 'object' && proto !== null; proto = Object.getPrototypeOf(proto)) {
    const named = Reflect.get(proto, 'constructor');
    const name = typeof named === 'function' ? named.name : '';
    const found = CRASH_CLASSES.find((known) => known === name && known !== 'other');
    if (found !== undefined) return found;
  }
  return 'other';
};

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** `file:///C:/a/b.js`, `C:\a\b.js`, and `/a/b.js` as one slash-separated path, so two machines' separators agree. */
const plain = (location: string): string => location.replace(/^file:\/\/\/?/, '').replaceAll('\\', '/');

/** Where a package's own files start in a path: after the last `dist/`, `src/`, or `node_modules/`. What lies before it is the machine's. */
const WITHIN = /^.*\/(?:dist|src|node_modules)\/(.*)$/;

const frameOf = (line: string): string | undefined => {
  const found = /^\s*at (?:(.*?) \()?(.*?)\)?$/.exec(line);
  if (found === null) return undefined;
  const name = found[1] ?? '';
  const place = /^(.*):(\d+):(\d+)$/.exec(found[2] ?? '');
  // A frame with no line and column is an engine frame (`node:internal/...`, `<anonymous>`): nothing of the machine's.
  if (place === null) return `${name}@${found[2] ?? ''}`;
  const path = plain(place[1] ?? '');
  const within = WITHIN.exec(path)?.[1];
  // Hashed either way: a package-relative path names no one, and one that is not inside a package is the machine's and is hashed whole.
  return `${name}@${short(within ?? path)}:${place[2] ?? ''}:${place[3] ?? ''}`;
};

/** 16 hex characters from the frames of the stack, the message's lines left out (a message can run over many lines, and none begins with `at`). */
export const stackHashOf = (error: unknown): string => {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .flatMap((line) => frameOf(line) ?? []);
  return createHash('sha256').update(frames.join('\n')).digest('hex').slice(0, 16);
};

/** Records a crash. It reads the error for its class and its frames only; the message is never touched. */
export const recordCrash = (emitter: Emitter, error: unknown): void => {
  emitEvent(emitter, 'crash', { errorClass: crashClassOf(error), stackHash: stackHashOf(error) });
};
