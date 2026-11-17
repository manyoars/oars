// The phases of `sessions deposit` and `sessions verify`, one process, one phase at a time. Run through `sessions-heap.mjs phases`,
// which sets the scratch environment and starts this with --expose-gc. Arguments: the store folder, the Claude config folder, and the shape
// of the run: `noop` (a deposit that skips every file, then verify) or `recapture` (a deposit that captures every transcript).
// For each phase: the heap in use before it (after a full collection), the largest heap sampled while it ran, and what it keeps after a full collection.
// The sample is taken by a timer every 2 ms, which cannot fire during synchronous work, so a phase that is one synchronous call (marked `*`) shows
// its heap at its end, not its peak, and no number here establishes which phase sets a command's peak: the figures show what is kept, and where
// the heap is large when a phase ends. (--trace-gc under a small cap would show true peaks; no run here takes that step.)
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

const runtime = { storeDir, projectsRoot: join(claudeDir, 'projects'), stdin: new PassThrough(), stdout: { write: () => true } };
/** @param {number} bytes */
const mb = (bytes) => Math.round(bytes / 1048576);
/** @typedef {import('../src/sessions/store.js').Store} Store */
/** @typedef {import('../src/sessions/schema.js').DerivedRecords} DerivedRecords */
/** @typedef {import('../src/sessions/read.js').Read} Read */
/** @typedef {import('../src/sessions/store.js').DepositResult} DepositResult */
/** @typedef {{ name: string, before: number, peak: number, kept: number, ms: number, sync: boolean }} PhaseRow */
/** @type {PhaseRow[]} */
const rows = [];

/**
 * Runs one phase and records the heap sampled during it and what it leaves behind; the phase's result is held by the caller, so the "kept" column
 * counts it. A synchronous phase (`sync`) is one call the 2 ms timer cannot interrupt, so its figure is the heap at its end.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} work
 * @param {boolean} [sync]
 * @returns {Promise<T>}
 */
const phase = async (name, work, sync = false) => {
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
  rows.push({ name, before: mb(before), peak: mb(peak), kept: mb(process.memoryUsage().heapUsed), ms, sync });
  return result;
};

console.log(`${'phase'.padEnd(52)} ${'before'.padStart(6)} ${'sampled'.padStart(8)} ${'kept'.padStart(6)} ${'ms'.padStart(7)}   (heap MB; * = synchronous, so the heap at its end)`);

if (shape === 'recapture') {
  // The whole run in one row: the scan, a capture of every transcript (one at a time), the compaction, and the refresh. It is not split into
  // capture, compaction, and refresh, so no figure here says which of them sets the recapture's heap.
  /** @type {DepositResult} */
  const deposited = await phase('deposit: recapture, whole run (scan+capture+compact+refresh)', () => store.deposit(runtime, { allow: ['bench-project'], redactDomains: [], now: Date.now }));
  // A deposit that captured nothing is a no-op, and its row would print as a measured recapture (the failure `sessions-heap.mjs` closes in check, table, and minheap).
  if (!(deposited.sessions > 0)) throw new Error(`the recapture shape captured ${String(deposited.sessions)} sessions: its row is not a recapture`);
} else {
  const log = join(storeDir, 'observations.jsonl');
  // Deposit: the newer-captures check is one pass over the log that keeps a number per session.
  await phase('deposit: scanLog for the newer-captures check', async () => (await store.scanLog(log)).newerCaptures);
  await phase('deposit: compactLog', () => store.compactLog(storeDir));
  // Deposit: the refresh the nightly runs, `store.refresh`: `foldRuns` (scan, runs), the derive finish, `currentPool` with the folds, then the index. The derive finish has no mark of its own (`store.ts` marks `finish` after the pool fold, `pool` after `currentPool`), so its row is shared with `currentPool`; it is 58 to 77 ms (t1405). It is split at the steps the refresh marks
  // (`refreshStep`), each row being the heap sampled from the previous mark to this one; the index step and what follows it are the last row. Nothing here takes the whole-store path of `currentPool`.
  const at = new Date().toISOString();
  const marks = ['scan', 'runs', 'finish', 'pool'];
  const before = rows.length;
  const stepNames = { scan: 'scan the log', runs: 'foldRuns runs', finish: 'pool fold finish', pool: 'derive.finish + currentPool (folds)' };
  let stepStart = performance.now();
  let stepPeak = process.memoryUsage().heapUsed;
  let stepBefore = stepPeak;
  const sampler = setInterval(() => {
    stepPeak = Math.max(stepPeak, process.memoryUsage().heapUsed);
  }, 2);
  const close = (/** @type {string} */ name) => {
    const now = process.memoryUsage().heapUsed;
    rows.push({ name, before: mb(stepBefore), peak: mb(Math.max(stepPeak, now)), kept: mb(now), ms: Math.round(performance.now() - stepStart), sync: false });
    stepStart = performance.now();
    stepBefore = now;
    stepPeak = now;
  };
  const stepped = { ...runtime, refreshStep: (/** @type {'scan' | 'runs' | 'finish' | 'pool'} */ step) => close(`deposit: refresh ${stepNames[step]}`) };
  global.gc?.();
  stepBefore = process.memoryUsage().heapUsed;
  stepPeak = stepBefore;
  stepStart = performance.now();
  await store.refresh(stepped, [], at);
  clearInterval(sampler);
  close('deposit: refresh index (buildIndex, write)');
  if (rows.length - before !== marks.length + 1) throw new Error(`the refresh marked ${String(rows.length - before - 1)} steps, not ${String(marks.length)}: its rows are not the nightly's`);

  // Verify, as `sessionsVerify` runs it: lean skeletons, then the store.
  const every = await phase('verify: readSkeletons lean (kept)', () => store.readSkeletons(storeDir, undefined, true));
  const verifyStore = await phase('verify: loadStore (kept)', () => store.loadStore(storeDir));
  const captured = [...verifyStore.sessions, ...verifyStore.subagents];
  await phase('verify: verifyAll + verifyCaptured + verifySessions', async () => {
    verify.verifyAll(every.skeletons, every.skeletons);
    verify.verifyCaptured(captured, verifyStore.tools);
    verify.verifySessions(every.skeletons, captured, verifyStore.tools);
  }, true);
  await phase('verify: selfBaselineOf', async () => baseline.selfBaseline(captured, verifyStore.tools, verifyStore.prompts, Date.now()), true);
  await phase('verify: auditStore', async () => audit.auditStore(runtime, captured, every.skeletons));
}

console.log(rows.map((row) => `${row.name.padEnd(52)} ${String(row.before).padStart(6)} ${(String(row.peak) + (row.sync ? "*" : "")).padStart(8)} ${String(row.kept).padStart(6)} ${String(row.ms).padStart(7)}`).join('\n'));
