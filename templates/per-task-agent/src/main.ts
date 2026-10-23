import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createBilling } from './billing.js';
import { ConfigError, loadConfig } from './config.js';
import { createFakeBilling } from './fake-billing.js';
import { createPageFetcher } from './fetch-page.js';
import { dnsResolve, nodeTransport } from './node-transport.js';
import { createSummarizer } from './summary.js';

try {
  const config = loadConfig(process.env);
  const billing =
    config.sdkKey === undefined || config.fakeBilling
      ? createFakeBilling({ now: Date.now })
      : createBilling({ apiUrl: config.apiUrl, sdkKey: config.sdkKey });
  if (config.fakeBilling) console.warn('OARS_DEV_FAKE_BILLING=1: in-memory fake billing, nothing is charged. Never run this in production.');
  const app = createApp({
    billing,
    priceRefs: config.priceRefs,
    fetchPage: createPageFetcher({ resolve: dnsResolve, transport: nodeTransport }),
    summarize: config.anthropicApiKey === undefined ? undefined : createSummarizer({ apiKey: config.anthropicApiKey, fetch: (request) => fetch(request) }),
    log: (entry) => {
      console.warn(JSON.stringify(entry));
    },
  });
  const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    console.info(`per-task-agent listening on :${String(port)}`);
  });
  process.once('SIGTERM', () => {
    server.close();
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`per-task-agent: ${error.message}`);
  process.exitCode = 1;
}
