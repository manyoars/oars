// The phases of `sessions deposit` and `sessions verify`, one process, one phase at a time (t808). Run through `sessions-heap.mjs phases`,
// which sets the scratch environment and starts this with --expose-gc. Arguments: the store folder and the Claude config folder.
// For each phase: heap in use when it ends (before a collection: the peak the phase reached), then what it keeps after a full collection.
import { PassThrough } from 'node:stream';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [storeDir, claudeDir] = process.argv.slice(2);
if (storeDir === undefined || claudeDir === undefined) throw new Error('usage: sessions-heap-phases.mjs <store> <claude config>');
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
/** @type {string[]} */
const rows = [];

/** Runs one phase and records its peak and what it leaves behind. `keep` holds the phase's result so the "kept" column counts it. */
/**
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
  const kept = process.memoryUsage().heapUsed;
  rows.push(`${name.padEnd(46)} ${String(mb(before)).padStart(6)} ${String(mb(peak)).padStart(7)} ${String(mb(kept)).padStart(6)} ${String(ms).padStart(7)}`);
  return result;
};

console.log(`${'phase'.padEnd(46)} ${'before'.padStart(6)} ${'peak'.padStart(7)} ${'kept'.padStart(6)} ${'ms'.padStart(7)}   (heap MB)`);

// Deposit: the newer-captures check loads the whole store and drops it.
await phase('deposit: loadStore for the newer-captures check', async () => (await store.loadStore(storeDir)).newerCaptures);
await phase('deposit: compactLog', () => store.compactLog(storeDir));
// Deposit: refresh loads it again and keeps it through derive, the pool, and the index.
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

// Verify.
const every = await phase('verify: readSkeletons (kept)', () => store.readSkeletons(storeDir));
const verifyStore = await phase('verify: loadStore (kept)', () => store.loadStore(storeDir));
const captured = [...verifyStore.sessions, ...verifyStore.subagents];
await phase('verify: verifyAll + verifyCaptured + verifySessions', async () => {
  verify.verifyAll(every.skeletons, every.skeletons);
  verify.verifyCaptured(captured, verifyStore.tools);
  verify.verifySessions(every.skeletons, captured, verifyStore.tools);
});
await phase('verify: selfBaselineOf', async () => baseline.selfBaseline(captured, verifyStore.tools, verifyStore.prompts, Date.now()));
await phase('verify: auditStore', async () => audit.auditStore(runtime, captured, every.skeletons));

console.log(rows.join('\n'));
