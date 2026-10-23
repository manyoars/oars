// The optional model summary. No test here uses a real key or the network: fetch is a mock.
import { describe, expect, it, vi } from 'vitest';
import { type Audit, auditPage } from '../src/audit.js';
import { createSummarizer } from '../src/summary.js';

const KEY = 'sk-ant-test-not-a-real-key';

const audit: Audit = auditPage({
  requestedUrl: 'https://acme.example/',
  finalUrl: 'https://acme.example/',
  html: '<title>Acme</title><h1>Widgets</h1>',
  bytes: 100,
  responseTimeMs: 50,
});

const reply = (body: unknown, status = 200): Promise<Response> => Promise.resolve(Response.json(body, { status }));

describe('createSummarizer', () => {
  it('posts the findings to the Anthropic messages API with the key, and returns the text it wrote', async () => {
    const send = vi.fn((_request: Request) => reply({ content: [{ type: 'text', text: '  A thin page: add a description.  ' }] }));
    const signal = new AbortController().signal;

    const summary = await createSummarizer({ apiKey: KEY, fetch: send })(audit, signal);

    expect(summary).toBe('A thin page: add a description.');
    const request = send.mock.calls[0]?.[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers.get('x-api-key')).toBe(KEY);
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request?.headers.get('content-type')).toBe('application/json');
    const body: unknown = await request?.json();
    expect(body).toMatchObject({ model: expect.stringMatching(/^claude-/), max_tokens: expect.any(Number) });
    expect(JSON.stringify(body)).toContain('Acme');
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('tells the model the page text is untrusted data, not instructions', async () => {
    const send = vi.fn((_request: Request) => reply({ content: [{ type: 'text', text: 'ok' }] }));

    await createSummarizer({ apiKey: KEY, fetch: send })(audit, new AbortController().signal);

    const body: unknown = await send.mock.calls[0]?.[0].json();
    expect(JSON.stringify(body)).toMatch(/untrusted/i);
  });

  it('passes the budget signal to the request', async () => {
    const controller = new AbortController();
    const send = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    }));
    const pending = createSummarizer({ apiKey: KEY, fetch: send })(audit, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it.each([
    ['an error status', () => reply({ error: { message: 'overloaded' } }, 529)],
    ['a body with no text', () => reply({ content: [] })],
    ['a body that is not the messages shape', () => reply({ nope: true })],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['empty text', () => reply({ content: [{ type: 'text', text: '   ' }] })],
  ])('throws on %s, and the error never carries the key', async (_name, answer) => {
    const failure = createSummarizer({ apiKey: KEY, fetch: answer })(audit, new AbortController().signal);

    await expect(failure).rejects.toThrow();
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain(KEY);
    });
  });
});
