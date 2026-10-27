import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { type Billing, createBilling } from './billing.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { createFakeBilling, createFakeRecovery } from './fake-billing.js';
import { createPageFetcher } from './fetch-page.js';
import { dnsResolve, nodeTransport } from './node-transport.js';
import { createRecovery, type Recovery } from './recovery.js';
import { createSummarizer } from './summary.js';

// Billing and recovery come from the same source: both fake in development, both the platform's calls otherwise.
const billingFor = (config: Config): { billing: Billing; recovery: Recovery } => {
  if (config.sdkKey === undefined || config.fakeBilling) {
    const billing = createFakeBilling({ now: Date.now });
    return { billing, recovery: createFakeRecovery({ billing, now: Date.now }) };
  }
  const options = { apiUrl: config.apiUrl, sdkKey: config.sdkKey };
  return { billing: createBilling(options), recovery: createRecovery(options) };
};

try {
  const config = loadConfig(process.env);
  const { billing, recovery } = billingFor(config);
  if (config.fakeBilling) console.warn('OARS_DEV_FAKE_BILLING=1: in-memory fake billing, nothing is charged. Never run this in production.');
  const app = createApp({
    billing,
    recovery,
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
