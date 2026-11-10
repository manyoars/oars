// The entry the hook starts, detached, at the hand-off mark or after an ask with no time to start: `node hook-fill-main.js <storeDir> <class> <name> <cwd>`. It prints nothing, answers nothing, and exits 0 whatever
// happens; nobody waits on it.
import { CROSSING_CLASSES } from './checks.js';
import { FILL_TIMEOUT_MS, runFill } from './hook-fill.js';
import { managerReader } from './registry.js';

const [storeDir, cls, name, cwd] = process.argv.slice(2);
const known = CROSSING_CLASSES.find((one) => one === cls);
try {
  if (storeDir !== undefined && known !== undefined && name !== undefined && cwd !== undefined) {
    await runFill(storeDir, { class: known, name, cwd }, { registry: managerReader(undefined, FILL_TIMEOUT_MS), now: Date.now });
  }
} catch {
  // Fail-open: an answer that cannot be kept is asked about again.
}
process.exit(0);
