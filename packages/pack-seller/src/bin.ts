#!/usr/bin/env node
import { start } from './server.js';

const started = await start(process.env);
if (!started.ok) {
  console.error(started.line);
  process.exit(1);
}
console.log(`Pack seller listening on port ${String(started.port)}.`);
