// The class table (field-classes.ts), the fields a format 3 batch carries (BATCH_FIELDS), and the class column of the wire field register in docs/pool.md must name the same fields with the same classes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BATCH_FIELDS } from '../../cli/src/sessions/pool-outbox.js';
import { classOf, FIELD_CLASSES, type FieldClass } from './field-classes.js';

const POOL_DOC = fileURLToPath(new URL('../../../docs/pool.md', import.meta.url));
const CLASSES: readonly FieldClass[] = ['clear', 'thresholded', 'hashed at ingest', 'raw tier'];

const classIn = (text: string | undefined): FieldClass | undefined => CLASSES.find((name) => text?.startsWith(name) === true);

/** The register's class column: the field, its class, and the class of a value off the public list when the cell names one after a semicolon. */
const registerClasses = (doc: string): Map<string, { class?: FieldClass; longTail?: FieldClass }> => {
  const section = doc.slice(doc.indexOf('## Wire field register'), doc.indexOf('\n## Routes'));
  const rows = new Map<string, { class?: FieldClass; longTail?: FieldClass }>();
  for (const line of section.split(/\r?\n/)) {
    const match = /^\| `([A-Za-z]+)` \| .+ \| ([^|]+) \| (?:yes|partly|no)/.exec(line);
    if (match === null) continue;
    const [first, second] = (match[2] ?? '').split('; ');
    const longTail = classIn(second);
    rows.set(match[1] ?? '', { class: classIn(first), ...(longTail === undefined ? {} : { longTail }) });
  }
  return rows;
};

describe('the class table', () => {
  it('has a row for every field the client emits, and no row for a field it does not', () => {
    expect(Object.keys(FIELD_CLASSES).sort()).toEqual([...BATCH_FIELDS].sort());
  });

  it('fails a field with no row: classOf names none', () => {
    expect(classOf('a-field-no-batch-carries')).toBeUndefined();
    expect(classOf('program')).toEqual({ class: 'clear', longTail: 'thresholded' });
  });

  it('hashes a host at ingest and thresholds every long-tail name', () => {
    expect(classOf('host')).toEqual({ class: 'hashed at ingest' });
    for (const field of ['model', 'harnessVersion', 'program', 'native', 'server', 'tool', 'skill', 'skills', 'mcp', 'name', 'sub', 'flags', 'version']) expect(classOf(field)?.longTail).toBe('thresholded');
  });

  it('equals the class column of the register in docs/pool.md', () => {
    const register = registerClasses(readFileSync(POOL_DOC, 'utf8'));
    expect([...register.keys()].sort()).toEqual(Object.keys(FIELD_CLASSES).sort());
    for (const [field, row] of Object.entries(FIELD_CLASSES)) expect(register.get(field), field).toEqual({ class: row.class, ...(row.longTail === undefined ? {} : { longTail: row.longTail }) });
  });
});
