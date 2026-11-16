#!/usr/bin/env node
import { ENV_HOST, ENV_PORT } from './config.js';
import { start } from './server.js';

try {
  const started = await start(process.env);
  if (!started.ok) {
    console.error(started.line);
    process.exit(1);
  }
  console.log(`Pack seller listening on port ${String(started.port)}.`);
} catch {
  // Listening failed (a taken port, an address this machine lacks). The system's message can name the address, so the line names the variables instead.
  console.error(`The pack seller could not listen: check ${ENV_PORT} and ${ENV_HOST}.`);
  process.exit(1);
}
