// The deterministic part of the task: read a page and judge it. Pure, so it needs no network and no key. Replace this file's
// auditPage (and the Audit it returns) with what your agent does.
import { type DefaultTreeAdapterMap, defaultTreeAdapter, html as htmlSpec, parse } from 'parse5';

type Element = DefaultTreeAdapterMap['element'];

export type CheckResult = 'pass' | 'warn' | 'fail';
export interface Check { check: string; result: CheckResult; message: string }
export interface OpenGraphTags { [property: string]: string }

export interface AuditInput {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  bytes: number;
  responseTimeMs: number;
}

/** What the page says about itself. */
export interface Findings {
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  openGraph: OpenGraphTags;
}

export interface Audit extends Findings {
  url: string;
  finalUrl: string;
  https: boolean;
  responseTimeMs: number;
  pageWeightBytes: number;
  checks: Check[];
}

// Thresholds: [longest that passes, longest that only warns].
const RESPONSE_MS: [number, number] = [1000, 3000];
const WEIGHT_BYTES: [number, number] = [1_048_576, 3_145_728];
const TITLE_LENGTH: [number, number] = [10, 60];
const DESCRIPTION_LENGTH: [number, number] = [50, 160];
const OPEN_GRAPH_REQUIRED = ['og:title', 'og:description', 'og:image'];

// --- reading the page -------------------------------------------------------------------------------------------------------
// Only HTML-namespace elements count, so an svg <title> is not the page title. Script and comment text never reaches us.
const elementsOf = (parent: { childNodes: Array<DefaultTreeAdapterMap['childNode']> }): Element[] =>
  parent.childNodes.flatMap((child) => (defaultTreeAdapter.isElementNode(child) ? [child, ...elementsOf(child)] : []))
    .filter((element) => element.namespaceURI === htmlSpec.NS.HTML);

const textOf = (element: Element): string => {
  const parts: string[] = [];
  const visit = (parent: Element): void => {
    for (const child of parent.childNodes) {
      if (defaultTreeAdapter.isTextNode(child)) parts.push(child.value);
      else if (defaultTreeAdapter.isElementNode(child) && child.tagName !== 'script' && child.tagName !== 'style') visit(child);
    }
  };
  visit(element);
  return parts.join('').replace(/\s+/g, ' ').trim();
};

const attribute = (element: Element, name: string): string => element.attrs.find((attr) => attr.name === name)?.value ?? '';

const nonEmpty = (text: string): string | null => (text === '' ? null : text);

const read = (html: string): Findings => {
  const elements = elementsOf(parse(html));
  const titleElement = elements.find((element) => element.tagName === 'title');
  const metas = elements.filter((element) => element.tagName === 'meta').map((element) => ({
    key: (attribute(element, 'property') || attribute(element, 'name')).trim().toLowerCase(),
    content: attribute(element, 'content').replace(/\s+/g, ' ').trim(),
  }));
  const openGraph: OpenGraphTags = {};
  for (const { key, content } of metas) {
    if (key.startsWith('og:') && content !== '' && openGraph[key] === undefined) openGraph[key] = content;
  }
  return {
    title: titleElement === undefined ? null : nonEmpty(textOf(titleElement)),
    metaDescription: metas.find((meta) => meta.key === 'description' && meta.content !== '')?.content ?? null,
    h1: elements.filter((element) => element.tagName === 'h1').map(textOf).filter((text) => text !== ''),
    openGraph,
  };
};

// --- judging it -------------------------------------------------------------------------------------------------------------
const rateUpTo = (value: number, [pass, warn]: [number, number]): CheckResult => {
  if (value <= pass) return 'pass';
  return value <= warn ? 'warn' : 'fail';
};

const rateLength = (text: string | null, [shortest, longest]: [number, number]): CheckResult => {
  if (text === null) return 'fail';
  return text.length >= shortest && text.length <= longest ? 'pass' : 'warn';
};

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;

const lengthCheck = (check: string, label: string, text: string | null, range: [number, number]): Check => {
  const result = rateLength(text, range);
  if (text === null) return { check, result, message: `No ${label} found.` };
  const advice = result === 'pass' ? '' : ` Aim for ${String(range[0])} to ${String(range[1])}.`;
  return { check, result, message: `The ${label} is ${String(text.length)} characters.${advice}` };
};

const headingCheck = (h1: string[]): Check => {
  if (h1.length === 0) return { check: 'h1', result: 'fail', message: 'No <h1> heading found.' };
  if (h1.length > 1) return { check: 'h1', result: 'warn', message: `${String(h1.length)} <h1> headings; use one.` };
  return { check: 'h1', result: 'pass', message: 'One <h1> heading.' };
};

const openGraphCheck = (tags: OpenGraphTags): Check => {
  const missing = OPEN_GRAPH_REQUIRED.filter((property) => tags[property] === undefined);
  if (Object.keys(tags).length === 0) return { check: 'open-graph', result: 'fail', message: 'No Open Graph tags found.' };
  if (missing.length > 0) return { check: 'open-graph', result: 'warn', message: `Open Graph is missing ${missing.join(', ')}.` };
  return { check: 'open-graph', result: 'pass', message: 'og:title, og:description and og:image are set.' };
};

/** Reads the page's title, meta description, h1, Open Graph tags, scheme, response time and weight, and judges each. */
export const auditPage = (input: AuditInput): Audit => {
  const https = new URL(input.finalUrl).protocol === 'https:';
  const responseTimeMs = Math.round(input.responseTimeMs);
  const found = read(input.html);
  const responseResult = rateUpTo(responseTimeMs, RESPONSE_MS);
  const weightResult = rateUpTo(input.bytes, WEIGHT_BYTES);
  const checks: Check[] = [
    { check: 'https', result: https ? 'pass' : 'fail', message: https ? 'Served over HTTPS.' : 'Served over plain HTTP. Redirect to HTTPS.' },
    {
      check: 'response-time',
      result: responseResult,
      message: `Responded in ${String(responseTimeMs)} ms.${responseResult === 'pass' ? '' : ` Aim for under ${String(RESPONSE_MS[0])} ms.`}`,
    },
    {
      check: 'page-weight',
      result: weightResult,
      message: `The HTML is ${kib(input.bytes)}.${weightResult === 'pass' ? '' : ` Aim for under ${kib(WEIGHT_BYTES[0])}.`}`,
    },
    lengthCheck('title', 'title', found.title, TITLE_LENGTH),
    lengthCheck('meta-description', 'meta description', found.metaDescription, DESCRIPTION_LENGTH),
    headingCheck(found.h1),
    openGraphCheck(found.openGraph),
  ];
  return { url: input.requestedUrl, finalUrl: input.finalUrl, https, responseTimeMs, pageWeightBytes: input.bytes, ...found, checks };
};
