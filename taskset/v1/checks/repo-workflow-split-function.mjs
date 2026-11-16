// repo-workflow-split-function: requestsCsv in src/export.ts is one function of about 50 lines. After the change every
// top-level declaration (from its first line to its closing brace or semicolon, found by matching brackets with comments, strings,
// templates and regular expressions masked; a class member by member) in every .ts file anywhere in the repository (not a test
// file, not node_modules) that the run changed or added is at most 20 lines, and
// requestsCsv returns exactly what the starting function returned (checks/_original/export.ts, run on the same seeded database)
// for no filter and for each status, and rejects a bad status with the same RangeError. src/export.ts is always measured in full. A declaration another changed file still holds
// word for word from the starting commit is not counted again. Wrong neighbors: nested helper functions inside requestsCsv, which
// look split but leave the one top-level function long; comment lines at column 0 inside the unchanged function; the whole
// function moved to another file and re-exported.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDb, check, expect, importFrom, openDb, readText, tempFolder } from './_shared.mjs';

const ORIGINAL = join(dirname(fileURLToPath(import.meta.url)), '_original', 'export.ts');
const MAX_LINES = 20;
const START = /^(export |const |let |var |function |async function |interface |type |class |enum |declare |abstract )/;
const START_REF = 'taskset-v1';
const OPENERS = '({[';
const CLOSERS = ')}]';

/** Index just past the string that starts at `i` (quote `q`). */
const skipString = (text, i, q) => {
  let j = i + 1;
  while (j < text.length && text[j] !== q && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
};

/** Index just past the template literal that starts at `i`, `${...}` parts included (they may hold strings and templates). */
const skipTemplate = (text, i) => {
  let j = i + 1;
  while (j < text.length && text[j] !== '`') {
    if (text[j] === '\\') j += 2;
    else if (text[j] === '$' && text[j + 1] === '{') j = skipBraces(text, j + 1);
    else j++;
  }
  return j + 1;
};

/** Index just past the `{ ... }` that starts at `i`. */
const skipBraces = (text, i) => {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === "'" || c === '"') j = skipString(text, j, c);
    else if (c === '`') j = skipTemplate(text, j);
    else {
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return j + 1;
      j++;
    }
  }
  return j;
};

/** The text with comments, string and template contents, and regular expressions blanked (newlines kept, so lines still line up). */
const mask = (text) => {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let last = '';
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    let end = i + 1;
    if (c === '/' && n === '/') {
      const newline = text.indexOf('\n', i);
      end = newline < 0 ? text.length : newline;
      blank(i, end);
    } else if (c === '/' && n === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + 2;
      blank(i, end);
    } else if (c === "'" || c === '"') {
      end = skipString(text, i, c);
      blank(i, end);
      last = 'a';
    } else if (c === '`') {
      end = skipTemplate(text, i);
      blank(i, end);
      last = 'a';
    } else if (c === '/' && (last === '' || '(,=:[!&|?{};'.includes(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      end = j + 1;
      blank(i, end);
      last = 'a';
    } else if (!/\s/.test(c)) {
      last = c;
    }
    i = end;
  }
  return out.join('');
};

/** The top-level declarations of a TypeScript file: { name, text, length } with the non-blank line count of each. */
const declarations = (text) => {
  const lines = text.split('\n');
  const masked = mask(text).split('\n');
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    if (!START.test(masked[index])) continue;
    let depth = 0;
    let end = -1;
    for (let row = index; row < lines.length && end < 0; row++) {
      if (row > index && START.test(masked[row])) break;
      const code = masked[row];
      for (let col = 0; col < code.length && end < 0; col++) {
        const c = code[col];
        if (OPENERS.includes(c)) depth++;
        else if (CLOSERS.includes(c)) {
          depth--;
          if (depth === 0 && c === '}' && /^\s*;?\s*$/.test(code.slice(col + 1))) end = row;
        } else if (c === ';' && depth === 0) end = row;
      }
    }
    if (end < 0) {
      end = index;
      while (end + 1 < lines.length && !START.test(masked[end + 1])) end++;
    }
    const own = lines.slice(index, end + 1);
    if (/^(export\s+)?(default\s+)?(abstract\s+)?class\b/.test(masked[index])) {
      found.push(...classMembers(lines, masked, index, end));
      continue;
    }
    found.push({ name: lines[index].slice(0, 60), text: own.join('\n'), length: own.filter((line) => line.trim() !== '').length });
  }
  return found;
};

/** A class is measured member by member (a method, a field, the constructor), since the prompt limits functions, not classes. */
const classMembers = (lines, masked, from, to) => {
  const found = [];
  let depth = 0;
  let start = -1;
  for (let row = from; row <= to; row++) {
    const code = masked[row];
    const before = depth;
    for (const c of code) {
      if (OPENERS.includes(c)) depth++;
      else if (CLOSERS.includes(c)) depth--;
    }
    if (row === from) continue;
    if (start < 0 && before === 1 && code.trim() !== '' && !code.trim().startsWith('}')) start = row;
    if (start >= 0 && depth === 1) {
      const own = lines.slice(start, row + 1);
      found.push({ name: `${lines[from].slice(0, 30).trim()} ${lines[start].trim().slice(0, 30)}`, text: own.join('\n'), length: own.filter((line) => line.trim() !== '').length });
      start = -1;
    }
  }
  return found;
};

const git = (run, ...args) => spawnSync('git', args, { cwd: run, encoding: 'utf8' });

/** Every .ts file the run changed (against the starting commit, committed or not) or added, anywhere in the repository but not a test file. */
const changedSources = (run) => {
  const known = git(run, 'rev-parse', '--verify', '--quiet', START_REF).status === 0 ? START_REF : 'HEAD';
  const changed = git(run, 'diff', '--name-only', known).stdout.split('\n');
  const added = git(run, 'ls-files', '--others', '--exclude-standard').stdout.split('\n');
  const measured = (file) => /\.ts$/.test(file) && !/(^|\/)node_modules\//.test(file) && !/\.(test|spec)\.ts$/.test(file);
  return { known, files: [...new Set(['src/export.ts', ...changed, ...added])].filter(measured) };
};

await check('repo-workflow-split-function', async (run) => {
  expect(readText(run, 'src/export.ts') !== null, 'src/export.ts is gone');
  const { known, files } = changedSources(run);
  const tooLong = [];
  for (const file of files) {
    const text = readText(run, file);
    if (text === null) continue;
    const before = git(run, 'show', `${known}:${file}`);
    const unchanged = new Set(before.status === 0 && file !== 'src/export.ts' ? declarations(before.stdout).map((declaration) => declaration.text) : []);
    for (const declaration of declarations(text)) {
      if (declaration.length > MAX_LINES && !unchanged.has(declaration.text)) tooLong.push(`${file}: ${declaration.name} is ${declaration.length}`);
    }
  }
  expect(tooLong.length === 0, `too long (over ${MAX_LINES} lines): ${tooLong.join('; ')}`);

  const copy = join(tempFolder('original-export'), 'repo');
  cpSync(join(run, 'src'), join(copy, 'src'), { recursive: true });
  copyFileSync(ORIGINAL, join(copy, 'src', 'export.ts'));
  const mine = await importFrom(run, 'src/export.ts');
  const original = await importFrom(copy, 'src/export.ts');
  expect(typeof mine.requestsCsv === 'function', 'src/export.ts no longer exports requestsCsv');
  const db = openDb(buildDb(run).path, true);
  for (const status of [null, 'pending', 'approved', 'rejected', 'delivered']) {
    expect(mine.requestsCsv(db, status) === original.requestsCsv(db, status), `requestsCsv(db, ${JSON.stringify(status)}) returns different text than before`);
  }
  let message = null;
  try {
    mine.requestsCsv(db, 'lost');
  } catch (error) {
    message = error instanceof RangeError ? error.message : `${error}`;
  }
  expect(message === 'status must be one of pending, approved, rejected, delivered', `a bad status gives ${JSON.stringify(message)}, not the original RangeError`);
  return `every declaration in ${files.length} changed file${files.length === 1 ? '' : 's'} is at most ${MAX_LINES} lines and the export is unchanged`;
});
