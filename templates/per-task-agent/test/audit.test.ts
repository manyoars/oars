// The deterministic findings: title, meta description, one h1, Open Graph tags, HTTPS, response time and page weight.
import { describe, expect, it } from 'vitest';
import { type AuditInput, auditPage } from '../src/audit.js';

const TITLE = 'Acme Widgets: handmade widgets for everyone';
const DESCRIPTION = 'Acme makes handmade widgets in small batches and ships them worldwide within two days, with a lifetime guarantee.';

const GOOD_HTML = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>${TITLE}</title>
  <meta name="description" content="${DESCRIPTION}">
  <meta property="og:title" content="Acme Widgets">
  <meta property="og:description" content="Handmade widgets">
  <meta property="og:image" content="https://acme.example/og.png">
  <meta property="og:url" content="https://acme.example/">
  <meta property="og:type" content="website">
</head><body><h1>Handmade widgets</h1><p>Hello</p></body></html>`;

const page = (html: string, overrides: Partial<AuditInput> = {}): AuditInput => ({
  requestedUrl: 'https://acme.example/',
  finalUrl: 'https://acme.example/',
  html,
  bytes: 20_000,
  responseTimeMs: 300,
  ...overrides,
});

const result = (audit: ReturnType<typeof auditPage>, check: string) => audit.checks.find((entry) => entry.check === check)?.result;

describe('auditPage: what it reads', () => {
  it('reads the title, description, h1, Open Graph tags, scheme, timing and weight of a good page', () => {
    const audit = auditPage(page(GOOD_HTML, { bytes: 1234, responseTimeMs: 412.6 }));

    expect(audit).toMatchObject({
      url: 'https://acme.example/',
      finalUrl: 'https://acme.example/',
      https: true,
      responseTimeMs: 413,
      pageWeightBytes: 1234,
      title: TITLE,
      metaDescription: DESCRIPTION,
      h1: ['Handmade widgets'],
      openGraph: {
        'og:title': 'Acme Widgets',
        'og:description': 'Handmade widgets',
        'og:image': 'https://acme.example/og.png',
        'og:url': 'https://acme.example/',
        'og:type': 'website',
      },
    });
  });

  it('passes every check on a good page, in a fixed order', () => {
    const audit = auditPage(page(GOOD_HTML));

    expect(audit.checks.map((entry) => entry.check)).toEqual(['https', 'response-time', 'page-weight', 'title', 'meta-description', 'h1', 'open-graph']);
    expect(audit.checks.map((entry) => entry.result)).toEqual(Array<string>(7).fill('pass'));
    for (const entry of audit.checks) expect(entry.message).not.toBe('');
  });

  it('decodes entities, collapses whitespace and reads text through nested tags', () => {
    const audit = auditPage(page('<title>\n  Fish &amp;   Chips \n</title><h1>Hello <span>big <b>wide</b></span> world</h1>'));

    expect(audit).toMatchObject({ title: 'Fish & Chips', h1: ['Hello big wide world'] });
  });

  it('reads the meta tags whatever their case, and Open Graph tags written with name= as well as property=', () => {
    const audit = auditPage(page('<META NAME="Description" CONTENT="Short one"><meta name="og:title" content="T"><meta property="OG:image" content="i.png">'));

    expect(audit).toMatchObject({ metaDescription: 'Short one', openGraph: { 'og:title': 'T', 'og:image': 'i.png' } });
  });

  it('ignores markup inside scripts, comments and svg', () => {
    const audit = auditPage(
      page('<head><script>var s = "<title>Fake</title><h1>Fake</h1>";</script><!-- <h1>Hidden</h1> --></head><body><svg><title>Icon</title></svg></body>'),
    );

    expect(audit).toMatchObject({ title: null, h1: [] });
  });

  it('reports no title, description or tags as null and empty', () => {
    expect(auditPage(page('<html><body>nothing</body></html>'))).toMatchObject({ title: null, metaDescription: null, h1: [], openGraph: {} });
  });

  it('judges https by the final URL, so an http page that redirects to https passes', () => {
    const audit = auditPage(page(GOOD_HTML, { requestedUrl: 'http://acme.example/', finalUrl: 'https://acme.example/' }));

    expect(audit).toMatchObject({ url: 'http://acme.example/', finalUrl: 'https://acme.example/', https: true });
    expect(result(audit, 'https')).toBe('pass');
  });
});

describe('auditPage: what it judges', () => {
  it('fails https for a page served over http', () => {
    expect(result(auditPage(page(GOOD_HTML, { finalUrl: 'http://acme.example/' })), 'https')).toBe('fail');
  });

  it.each([
    [800, 'pass'],
    [1000, 'pass'],
    [1500, 'warn'],
    [3000, 'warn'],
    [4000, 'fail'],
  ])('rates a %i ms response %s', (responseTimeMs, expected) => {
    expect(result(auditPage(page(GOOD_HTML, { responseTimeMs })), 'response-time')).toBe(expected);
  });

  it.each([
    [200_000, 'pass'],
    [1_048_576, 'pass'],
    [2_000_000, 'warn'],
    [3_145_728, 'warn'],
    [4_000_000, 'fail'],
  ])('rates a %i byte page %s', (bytes, expected) => {
    expect(result(auditPage(page(GOOD_HTML, { bytes })), 'page-weight')).toBe(expected);
  });

  it.each([
    ['<title></title>', 'fail'],
    ['<title>   </title>', 'fail'],
    ['<html></html>', 'fail'],
    ['<title>Hi</title>', 'warn'],
    ['<title>A title that is long enough but that keeps on going well past sixty characters</title>', 'warn'],
    [`<title>${TITLE}</title>`, 'pass'],
  ])('rates the title in %s %s', (html, expected) => {
    expect(result(auditPage(page(html)), 'title')).toBe(expected);
  });

  it.each([
    ['<html></html>', 'fail'],
    ['<meta name="description" content="">', 'fail'],
    ['<meta name="description" content="Too short to say anything">', 'warn'],
    [`<meta name="description" content="${'x'.repeat(200)}">`, 'warn'],
    [`<meta name="description" content="${DESCRIPTION}">`, 'pass'],
  ])('rates the meta description in %s %s', (html, expected) => {
    expect(result(auditPage(page(html)), 'meta-description')).toBe(expected);
  });

  it.each([
    ['<html></html>', 'fail', []],
    ['<h1></h1>', 'fail', []],
    ['<h1>One</h1>', 'pass', ['One']],
    ['<h1>One</h1><h1>Two</h1>', 'warn', ['One', 'Two']],
  ])('rates the h1 in %s %s', (html, expected, headings) => {
    const audit = auditPage(page(html));

    expect(result(audit, 'h1')).toBe(expected);
    expect(audit.h1).toEqual(headings);
  });

  it.each([
    ['<html></html>', 'fail'],
    ['<meta property="og:title" content="T">', 'warn'],
    ['<meta property="og:title" content="T"><meta property="og:description" content="D">', 'warn'],
    ['<meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:image" content="i.png">', 'pass'],
    ['<meta property="og:title" content=""><meta property="og:description" content="D"><meta property="og:image" content="i.png">', 'warn'],
  ])('rates the Open Graph tags in %s %s', (html, expected) => {
    expect(result(auditPage(page(html)), 'open-graph')).toBe(expected);
  });

  it('names what is missing in the Open Graph message', () => {
    const audit = auditPage(page('<meta property="og:title" content="T">'));

    const message = audit.checks.find((entry) => entry.check === 'open-graph')?.message ?? '';
    expect(message).toContain('og:description');
    expect(message).toContain('og:image');
    expect(message).not.toContain('og:title');
  });
});
