import { http, HttpResponse, passthrough } from 'msw';
import { describe, expect, it } from 'vitest';
import { ENV_API_URL, ENV_PORT, ENV_SDK_KEY } from './config.js';
import { createSellerServer, start } from './server.js';
import { API, catalog, SDK_KEY, server, useServer } from './test-support.js';

useServer();

const REF = 'c_0123456789abcdef0123456789abcdef';

describe('start', () => {
  it('sends the SDK key in X-Agent-SDK-Key and no Authorization header', async () => {
    const seen: { sdk: string | null; authorization: string | null }[] = [];
    server.use(
      http.all('http://127.0.0.1:*/*', () => passthrough()),
      http.get(`${API}/billing/credits/${REF}`, ({ request }) => {
        seen.push({ sdk: request.headers.get('X-Agent-SDK-Key'), authorization: request.headers.get('Authorization') });
        return HttpResponse.json({ creditsAvailable: 3, creditsHeld: 0, creditsRemaining: 3, customerRef: REF, livemode: false });
      }),
    );
    const started = await start({ [ENV_API_URL]: API, [ENV_SDK_KEY]: SDK_KEY, [ENV_PORT]: '0' }, { log: () => undefined });
    if (!started.ok) throw new Error(started.line);
    try {
      const response = await fetch(`http://127.0.0.1:${String(started.port)}/credits`, { headers: { 'X-Customer-Ref': REF } });
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ sdk: SDK_KEY, authorization: null }]);
    } finally {
      started.server.close();
    }
  });
});

describe('the 500 path', () => {
  it('answers a fixed one-line body when a handler throws', async () => {
    server.use(http.all('http://127.0.0.1:*/*', () => passthrough()));
    const throwing = { ...catalog, list: () => { throw new Error('secret detail aorsk_x'); } };
    const sellerServer = createSellerServer({ config: { apiUrl: API, sdkKey: SDK_KEY, port: 0, host: '127.0.0.1' }, catalog: throwing, log: () => undefined });
    await new Promise<void>((resolve) => sellerServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = sellerServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${String(port)}/packs`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"Internal error."}');
    } finally {
      sellerServer.close();
    }
  });
});
