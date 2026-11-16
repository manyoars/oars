// Runs the run folder's own page script (public/app.js) against its own server, with a stand-in for the few browser
// objects the script touches, so a browser task is checked without a browser. What the script writes into the stand-in
// elements is what the page shows; an error the script throws without catching it is what the console would show.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, fail } from './_shared.mjs';

/** Like the DOM: reading textContent joins the text of the children, and writing it replaces the children with that text. */
const element = (tag = 'div') => {
  let own = '';
  return {
    tag,
    get textContent() {
      return own + this.children.map((child) => (typeof child === 'string' ? child : (child.textContent ?? child.label ?? ''))).join('');
    },
    set textContent(text) {
      own = String(text);
      this.children = [];
    },
    href: '',
    children: [],
    listeners: {},
    elements: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      own = '';
      this.children = nodes;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
};

/**
 * Loads `public/app.js` from `run` once, waits until every request it made has been answered and handled, and returns
 * `{ heading, summary, rows, footer, errors }`: the h1 text, the summary text, the table's cells per row, the footer
 * links as `{ text, href }`, and the messages of errors that nothing caught. `rewrite` may change a request's URL.
 */
export const renderPage = async (run, base, rewrite = (url) => url) => {
  const heading = element('h1');
  const summary = element('p');
  const tbody = element('tbody');
  const footer = element('ul');
  const form = element('form');
  form.elements = { member: element('select'), item: element('select'), quantity: { value: '1' }, note: { value: '' } };
  const bySelector = { h1: heading, '#summary': summary, '#requests tbody': tbody, '#footer-links': footer, '#request-form': form };
  const errors = [];
  let inFlight = 0;

  globalThis.document = {
    querySelector: (selector) => bySelector[selector] ?? fail(`app.js looked for ${selector}, which the page does not have`),
    createElement: element,
    // A text node is its text: textContent reads a string child as it is.
    createTextNode: (text) => String(text),
  };
  globalThis.Option = class {
    constructor(label, value) {
      this.label = label;
      this.value = value;
    }
  };
  globalThis.fetch = async (url, init) => {
    inFlight += 1;
    try {
      const res = await fetch_(`${base}${rewrite(url)}`, init);
      // The request is in flight until its body is read (json, text, blob, or arrayBuffer) or, for a response the script never reads, at once.
      // A request counts down exactly once, so a text() on a response, or a json() after a refusal, cannot leave it off zero.
      let settled = false;
      const settle = () => {
        if (!settled) inFlight -= 1;
        settled = true;
      };
      for (const reader of ['json', 'text', 'blob', 'arrayBuffer']) {
        const read = res[reader].bind(res);
        res[reader] = async () => {
          try {
            return await read();
          } finally {
            settle();
          }
        };
      }
      if (!res.ok) settle();
      return res;
    } catch (error) {
      inFlight -= 1;
      throw error;
    }
  };
  process.on('unhandledRejection', (reason) => errors.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)));
  process.on('uncaughtException', (error) => errors.push(`${error.name}: ${error.message}`));

  try {
    await import(pathToFileURL(join(run, 'public', 'app.js')).href);
  } catch (error) {
    errors.push(`${error.name}: ${error.message}`);
  }
  // Everything after a response is a microtask, so a macrotask tick with nothing in flight means the script is idle.
  const deadline = Date.now() + 30_000;
  let idleTicks = 0;
  while (idleTicks < 3) {
    await new Promise((resolveTick) => setImmediate(resolveTick));
    idleTicks = inFlight === 0 ? idleTicks + 1 : 0;
    expect(Date.now() < deadline, 'the page script was still loading after 30 s');
  }

  globalThis.fetch = fetch_;
  const cellsOf = (tr) => tr.children.map((td) => td.textContent);
  return {
    heading: heading.textContent,
    summary: summary.textContent,
    rows: tbody.children.map(cellsOf),
    footer: footer.children.map((li) => ({ text: li.children[0]?.textContent, href: li.children[0]?.href })),
    errors,
  };
};

const fetch_ = globalThis.fetch;

/** `$12.34` or `$-12.34` to cents. */
export const centsOf = (text) => Math.round(Number.parseFloat(String(text).replace(/[^0-9.-]/g, '')) * 100);
