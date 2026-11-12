// Shape tool: compares a real session file with the made-up fixture of the same harness and lists the field paths (with value types) that
// one has and the other lacks. Usage: node shape.mjs <harness> <session file>. It prints no value, ever: only paths and the types string,
// number, boolean, null, object, and array. A key that is not a plain identifier prints as `*`, so a path, tool name, or id used as a
// key cannot leak. Run it on your own machine; the file is read and nothing is sent or written.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Harnesses whose session is one JSON or JSON-lines file, and the fixture each is compared with. Cursor and OpenCode keep rows in a database. */
export const FIXTURES = {
  'claude-code': 'claude-code.jsonl',
  codex: 'codex.jsonl',
  copilot: 'copilot.jsonl',
  gemini: 'gemini.jsonl',
  grok: 'grok.updates.jsonl',
  pi: 'pi.jsonl',
  'vscode-copilot': 'vscode-copilot.json',
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/** @param {unknown} value */
const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean');

/** @param {string} text one JSON document, or one JSON document per line @returns {unknown[]} */
const documents = (text) => {
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
};

/** @param {unknown} value @param {string} path @param {Set<string>} out */
const walk = (value, path, out) => {
  out.add(`${path === '' ? '(root)' : path}: ${typeOf(value)}`);
  if (Array.isArray(value)) for (const item of value) walk(item, `${path}[]`, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walk(child, `${path === '' ? '' : `${path}.`}${IDENTIFIER.test(key) ? key : '*'}`, out);
  }
};

/** @param {string} text @returns {Set<string>} */
export const fieldSet = (text) => {
  const out = new Set();
  for (const doc of documents(text)) walk(doc, '', out);
  return out;
};

/** @param {string} sessionText @param {string} fixtureText */
export const compareShapes = (sessionText, fixtureText) => {
  const session = fieldSet(sessionText);
  const fixture = fieldSet(fixtureText);
  return {
    onlyInSession: [...session].filter((field) => !fixture.has(field)).sort(),
    onlyInFixture: [...fixture].filter((field) => !session.has(field)).sort(),
  };
};

/** @param {{ onlyInSession: string[], onlyInFixture: string[] }} result */
export const render = (result) =>
  [
    `only in the session file (${result.onlyInSession.length}):`,
    ...result.onlyInSession.map((field) => `  ${field}`),
    `only in the fixture (${result.onlyInFixture.length}):`,
    ...result.onlyInFixture.map((field) => `  ${field}`),
  ].join('\n');

const main = () => {
  const [harness, file] = process.argv.slice(2);
  const fixture = harness === undefined ? undefined : /** @type {Record<string, string>} */ (FIXTURES)[harness];
  if (fixture === undefined || file === undefined) {
    console.error(`usage: node shape.mjs <${Object.keys(FIXTURES).join('|')}> <session file>`);
    return 2;
  }
  const fixtureText = readFileSync(fileURLToPath(new URL(`./${fixture}`, import.meta.url)), 'utf8');
  console.log(render(compareShapes(readFileSync(file, 'utf8'), fixtureText)));
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
