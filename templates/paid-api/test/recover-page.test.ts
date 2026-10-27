// public/recover.html carries a secret from the buyer's mailbox to the agent. Its one rule: the link token stays in the
// fragment, which a browser never sends, until the buyer clicks, and then goes in a POST body to /v1/recover/redeem.
// The script runs here in a bare vm context with stub page objects, so what it does (not what it says) is what is checked.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { flush } from './support.js';

const html = readFileSync(new URL('../public/recover.html', import.meta.url), 'utf8');
const LINK = 'LinkTokenFromTheEmail0123456789abcdefghijk';

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, source]) => source ?? '');

class StubElement {
  hidden = false;
  disabled = false;
  textContent = '';
  value = '';
  private readonly listeners: (() => unknown)[] = [];
  addEventListener(type: string, listener: () => unknown): void {
    if (type === 'click') this.listeners.push(listener);
  }
  click(): void {
    if (!this.disabled) for (const listener of this.listeners) void listener();
  }
}

interface Call {
  url: string;
  init: { method?: string; headers?: { [name: string]: string }; body?: string };
}

const load = (hash: string, answer: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) => {
  const elements = new Map<string, StubElement>();
  const calls: Call[] = [];
  const replaced: string[] = [];
  runInNewContext(scripts.join('\n'), {
    document: {
      getElementById: (id: string): StubElement => {
        const element = elements.get(id) ?? new StubElement();
        elements.set(id, element);
        return element;
      },
    },
    location: { hash, pathname: '/recover', search: '' },
    history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
    fetch: (url: string, init: Call['init']) => {
      calls.push({ url, init });
      return answer();
    },
  });
  const element = (id: string): StubElement => {
    const found = elements.get(id);
    if (found === undefined) throw new Error(`recover.html never looks up #${id}`);
    return found;
  };
  return { calls, replaced, element };
};

const reply = (status: number, body: unknown) => () => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
const redeemed = reply(200, { token: 'oc_NewTokenShownOnce', customerRef: 'cus_x', creditsRemaining: 99 });

describe('recover.html', () => {
  it('is one self-contained page: an inline script and no links, forms, images, frames or other files', () => {
    expect(scripts).toHaveLength(1);
    expect(html).not.toMatch(/<(a|form|img|iframe|link|embed|object)[\s>]/i);
    expect(html).not.toMatch(/\s(src|href|action)=/i);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it('never reads the token from the path or the query, and never writes it to a URL, a cookie or storage', () => {
    for (const forbidden of ['location.search', 'location.href', 'document.referrer', 'URLSearchParams', 'XMLHttpRequest', 'sendBeacon', 'window.open', 'document.cookie', 'localStorage', 'sessionStorage']) {
      expect(scripts.join('\n')).not.toContain(forbidden);
    }
    expect(scripts.join('\n')).toContain('location.hash');
  });

  it('does nothing with the link on load: no request, the fragment taken out of the address bar, the button shown', () => {
    const page = load(`#${LINK}`, redeemed);

    expect(page.calls).toEqual([]);
    expect(page.replaced).toEqual(['/recover']);
    expect(page.element('redeem').hidden).toBe(false);
  });

  it('posts the token to /v1/recover/redeem on click, in the body and nowhere in the URL or the headers', async () => {
    const page = load(`#${LINK}`, redeemed);

    page.element('redeem-button').click();
    await flush();

    expect(page.calls).toHaveLength(1);
    const [call] = page.calls;
    expect(call?.url).toBe('/v1/recover/redeem');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(call?.init.body ?? '')).toEqual({ recoveryToken: LINK });
  });

  it('shows the new token once, says to keep it, and a second click sends nothing', async () => {
    const page = load(`#${LINK}`, redeemed);

    page.element('redeem-button').click();
    await flush();
    page.element('redeem-button').click();
    await flush();

    expect(page.calls).toHaveLength(1);
    expect(page.element('new-token').textContent).toBe('oc_NewTokenShownOnce');
    expect(page.element('new-token-box').hidden).toBe(false);
    expect(page.element('status').textContent).toMatch(/99 credits/);
  });

  it("shows the agent's message for an expired or used link, no token, and stays disabled", async () => {
    const page = load(`#${LINK}`, reply(410, { code: 'RECOVERY_LINK_INVALID', message: 'That link has expired or was already used.' }));

    page.element('redeem-button').click();
    await flush();

    expect(page.element('status').textContent).toContain('That link has expired or was already used.');
    expect(page.element('new-token-box').hidden).toBe(true);
    expect(page.element('redeem-button').disabled).toBe(true);
  });

  it('lets the buyer click again when the server could not be reached', async () => {
    const page = load(`#${LINK}`, () => Promise.reject(new Error('offline')));

    page.element('redeem-button').click();
    await flush();

    expect(page.element('status').textContent).toMatch(/could not reach/i);
    expect(page.element('redeem-button').disabled).toBe(false);
  });

  it('with no fragment hides the redeem button and offers the email form, which posts only the email to /v1/recover', async () => {
    const page = load('', reply(202, { accepted: true, message: 'If that email holds credits here, a link is on its way.' }));
    page.element('email').value = ' buyer@example.com ';

    page.element('send-link').click();
    await flush();

    expect(page.element('redeem').hidden).toBe(true);
    expect(page.replaced).toEqual([]);
    expect(page.calls).toHaveLength(1);
    const [call] = page.calls;
    expect(call?.url).toBe('/v1/recover');
    expect(call?.init.method).toBe('POST');
    expect(JSON.parse(call?.init.body ?? '')).toEqual({ email: 'buyer@example.com' });
    expect(page.element('status').textContent).toContain('a link is on its way');
  });

  it('treats a bare # as no link', () => {
    const page = load('#', redeemed);

    expect(page.element('redeem').hidden).toBe(true);
  });
});
