#!/usr/bin/env node
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultConfigDir, fileCredentialStore } from '../../cli/src/credentials.js';
import { resolveAuthToken } from '../../cli/src/session.js';
import { runPrice } from './price.js';
import { SELLER_VERSION, start } from './server.js';

if (process.argv[2] === 'price') {
  const result = await runPrice(process.env, {
    token: (apiUrl) =>
      resolveAuthToken(
        {
          env: process.env,
          io: { stdout: () => undefined, stderr: () => undefined },
          store: fileCredentialStore(defaultConfigDir(process.env, process.platform, homedir())),
          version: SELLER_VERSION,
          sleep: (ms) => sleep(ms),
          random: Math.random,
          now: Date.now,
          openBrowser: () => Promise.reject(new Error('The price command opens no browser.')),
        },
        apiUrl,
      ),
  });
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  process.exit(result.ok ? 0 : 1);
}

const started = await start(process.env);
if (!started.ok) {
  console.error(started.line);
  process.exit(1);
}
console.log(`Pack seller listening on port ${String(started.port)}.`);
