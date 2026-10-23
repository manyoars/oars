import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createBilling } from './billing.js';
import { ConfigError, loadConfig } from './config.js';
import { createFakeBilling } from './fake-billing.js';

try {
  const config = loadConfig(process.env);
  const billing =
    config.sdkKey === undefined || config.fakeBilling
      ? createFakeBilling({ now: Date.now })
      : createBilling({ apiUrl: config.apiUrl, sdkKey: config.sdkKey });
  if (config.fakeBilling) console.warn('OARS_DEV_FAKE_BILLING=1: in-memory fake billing, nothing is charged. Never run this in production.');
  const server = serve({ fetch: createApp({ billing, priceRefs: config.priceRefs }).fetch, port: config.port }, ({ port }) => {
    console.info(`paid-api listening on :${String(port)}`);
  });
  process.once('SIGTERM', () => {
    server.close();
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`paid-api: ${error.message}`);
  process.exitCode = 1;
}
