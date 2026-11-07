// The entry `startDailySend` starts, detached: `node send-main.js <telemetry folder>`. It prints nothing, answers nothing, and exits 0 whatever happens; nobody waits on it.
import { sendSpool } from './send.js';

const [dir] = process.argv.slice(2);
try {
  if (dir !== undefined) await sendSpool({ env: process.env, dir, now: Date.now });
} catch {
  // Fail-open: the spool is sent at the next try.
}
process.exit(0);
