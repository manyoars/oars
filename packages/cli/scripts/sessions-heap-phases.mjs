// The phases of `sessions deposit` and `sessions verify`, one process, one phase at a time (t808). Run through `sessions-heap.mjs phases`,
// which sets the scratch environment and starts this with --expose-gc. Arguments: the store folder, the Claude config folder, and the shape
// of the run: `noop` (a deposit that skips every file, then verify) or `recapture` (a deposit that captures every transcript).
// For each phase: heap in use when it ends (before a collection: the peak the phase reached), then what it keeps after a full collection.
import { PassThrough } from 'node:stream';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [storeDir, claudeDir, shape] = process.argv.slice(2);
if (storeDir === undefined || claudeDir === undefined || (shape !== 'noop' && shape !== 'recapture')) throw new Error('usage: sessions-heap-phases.mjs <store> <claude config> noop|recapture');
if (!resolve(storeDir).startsWith(resolve(tmpdir()) + sep)) throw new Error(`${storeDir} is not under the OS temp folder: refusing to run`);

/** @param {string} name */
const dist = (name) => import(pathToFileURL(join(fileURLToPath(new URL('../dist/sessions/', import.meta.url)), name)).href);
const store = await dist('store.js');
const verify = await dist('verify.js');
const audit = await dist('audit.js');
const baseline = await dist('baseline.js');
const pool = await dist('pool.js');
const index = await dist('hook-index.js');

const runtime = { storeDir, projectsRoot: join(claudeDir, 'projects'), stdin: new PassThrough(), stdout: { write: () => true } };
/** @param {number} bytes */
const mb = (bytes) => Math.round(bytes / 1048576);
/** @typedef {{ name: string, before: number, peak: number, kept: number, ms: number }} PhaseRow */
/** @type {PhaseRow[]} */
const rows = [];

/**
 * Runs one phase and records its peak and what it leaves behind; the phase's result is held by the caller, so the "kept" column counts it.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
const phase = async (name, work) => {
  const gc = /** @type {() => void} */ (global.gc);
  gc();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 2);
  const started = performance.now();
  const result = await work();
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const ms = Math.round(performance.now() - started);
  gc();
  rows.push({ name, before: mb(before), peak: mb(peak), kept: mb(process.memoryUsage().heapUsed), ms });
  return result;
};

console.log(`${'phase'.padEnd(52)} ${'before'.padStart(6)} ${'peak'.padStart(7)} ${'kept'.padStart(6)} ${'ms'.padStart(7)}   (heap MB)`);

if (shape === 'recapture') {
  // The whole run, because capture is not separable from outside: the scan, a capture of every transcript (one at a time), the compaction,
  // and the refresh. Its peak is the larger of the capture's (one transcript, plus the records appended) and the refresh's (see `noop`).
  await phase('deposit: recapture, whole run (scan+capture+compact+refresh)', () => store.deposit(runtime, { allow: ['bench-project'], redactDomains: [], now: Date.now }));
} else {
  const log = join(storeDir, 'observations.jsonl');
  // Deposit: the newer-captures check is one pass over the log that keeps a number per session.
  await phase('deposit: scanLog for the newer-captures check', async () => (await store.scanLog(log)).newerCaptures);
  await phase('deposit: compactLog', () => store.compactLog(storeDir));
  // Deposit: refresh loads the store and keeps it through derive, the pool, and the index.
  /** @type {any} */
  let loaded;
  await phase('deposit: refresh loadStore (kept)', async () => {
    loaded = await store.loadStore(storeDir);
  });
  const at = new Date().toISOString();
  /** @type {any} */
  let derived;
  await phase('deposit: refresh derive (store kept)', async () => {
    derived = store.derive(loaded, at);
  });
  await phase('deposit: refresh JSON.stringify(derived)', async () => JSON.stringify(derived).length);
  /** @type {any} */
  let reads;
  await phase('deposit: refresh currentPool (store kept)', async () => {
    reads = (await pool.currentPool(storeDir, loaded))?.reads ?? [];
  });
  await phase('deposit: refresh buildIndex (store kept)', async () => JSON.stringify(index.buildIndex(loaded, [], at, reads)).length);
  loaded = undefined;
  derived = undefined;
  reads = undefined;

  // Verify, as `sessionsVerify` runs it: lean skeletons, then the store.
  const every = await phase('verify: readSkeletons lean (kept)', () => store.readSkeletons(storeDir, undefined, true));
  const verifyStore = await phase('verify: loadStore (kept)', () => store.loadStore(storeDir));
  const captured = [...verifyStore.sessions, ...verifyStore.subagents];
  await phase('verify: verifyAll + verifyCaptured + verifySessions', async () => {
    verify.verifyAll(every.skeletons, every.skeletons);
    verify.verifyCaptured(captured, verifyStore.tools);
    verify.verifySessions(every.skeletons, captured, verifyStore.tools);
  });
  await phase('verify: selfBaselineOf', async () => baseline.selfBaseline(captured, verifyStore.tools, verifyStore.prompts, Date.now()));
  await phase('verify: auditStore', async () => audit.auditStore(runtime, captured, every.skeletons));
}

console.log(rows.map((row) => `${row.name.padEnd(52)} ${String(row.before).padStart(6)} ${String(row.peak).padStart(7)} ${String(row.kept).padStart(6)} ${String(row.ms).padStart(7)}`).join('\n'));
