import { setTimeout as sleep } from 'node:timers/promises';
import { defaultConfigDir, fileCredentialStore } from '../../cli/src/credentials.js';
import { resolveAuthToken } from '../../cli/src/session.js';
import type { PriceDeps } from './price.js';
import { SELLER_VERSION } from './server.js';

/**
 * The price command's token source: the CLI's own resolution, so `OARS_API_KEY` wins and otherwise the login under
 * `<APPDATA or XDG_CONFIG_HOME>/oars/credentials.json` is used. It prints nothing and opens no browser.
 */
export const priceDeps = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): PriceDeps => ({
  token: (apiUrl) =>
    resolveAuthToken(
      {
        env,
        io: { stdout: () => undefined, stderr: () => undefined },
        store: fileCredentialStore(defaultConfigDir(env, platform, home)),
        version: SELLER_VERSION,
        sleep: (ms) => sleep(ms),
        random: Math.random,
        now: Date.now,
        openBrowser: () => Promise.reject(new Error('The price command opens no browser.')),
      },
      apiUrl,
    ),
});
