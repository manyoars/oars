#!/usr/bin/env node
import { homedir } from 'node:os';
import { runPrice } from './price.js';
import { priceDeps } from './price-deps.js';
import { start } from './server.js';

if (process.argv[2] === 'price') {
  const result = await runPrice(process.env, priceDeps(process.env, process.platform, homedir()));
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  process.exit(result.ok ? 0 : 1);
}

const started = await start(process.env);
if (!started.ok) {
  console.error(started.line);
  process.exit(1);
}
console.log(`Pack seller listening on port ${String(started.port)}.`);
