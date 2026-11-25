// Preload for `sessions-heap.mjs reads`: names the frames that hold the heap when a run dies of memory. V8's fatal-error report has no JavaScript stack for an
// out-of-memory death ("No stack."), so this starts V8's sampling heap profiler on the main thread and reads it from a worker thread, whose inspector session is
// answered between the main thread's instructions even while it runs one synchronous loop. Every two seconds it appends a line to the file named by OARS_HEAP_FRAMES
// (a write from the worker, so the last one survives the main thread's death): the seconds since start, the live heap by allocating frame (the largest frames by the
// bytes they allocated that are still alive), and the callers of the largest one. The sampling interval (512 KiB) keeps the profiler's own cost small.
'use strict';
const { appendFileSync } = require('node:fs');
const inspector = require('node:inspector');
const { isMainThread, Worker, workerData } = require('node:worker_threads');

/** @typedef {import('node:inspector').HeapProfiler.SamplingHeapProfileNode} ProfileNode */
/** @typedef {import('node:inspector').Runtime.CallFrame} CallFrame */

/** @param {CallFrame} frame */
const nameOf = ({ functionName, url, lineNumber }) => `${functionName === '' ? '(anonymous)' : functionName} (${url.replace(/^file:\/\//, '').replace(/^.*[\\/]dist[\\/]/, 'dist/')}:${String(lineNumber + 1)})`;

/** @param {number} bytes */
const mb = (bytes) => Math.round(bytes / 1048576);

/**
 * The live heap by allocating frame: its total, the six largest frames, and the callers of the largest, nearest first.
 * @param {ProfileNode} head
 */
const summarize = (head) => {
  /** @type {Map<string, number>} */
  const self = new Map();
  /** @type {Map<string, string[]>} */
  const callers = new Map();
  /**
   * @param {ProfileNode} node
   * @param {string[]} path
   */
  const walk = (node, path) => {
    const here = nameOf(node.callFrame);
    self.set(here, (self.get(here) ?? 0) + node.selfSize);
    if (node.selfSize > 0 && !callers.has(here)) callers.set(here, path.slice(0, 5));
    for (const child of node.children) walk(child, [here, ...path]);
  };
  walk(head, []);
  const total = [...self.values()].reduce((sum, size) => sum + size, 0);
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const [largest] = top;
  return { liveMb: mb(total), top: top.map(([frame, size]) => ({ frame, mb: mb(size) })), callersOfTop: largest === undefined ? [] : (callers.get(largest[0]) ?? []) };
};

if (isMainThread) {
  const out = process.env.OARS_HEAP_FRAMES;
  if (out !== undefined && out !== '') {
    // Sampling starts here, where the inspector answers at once: a worker's first request can wait on the main thread for the whole run (seen on Node 22 when the main thread is busy as the worker connects).
    const main = new inspector.Session();
    main.connect();
    main.post('HeapProfiler.enable');
    main.post('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 });
    // The worker takes no preload: it would start another worker and a profiler of its own, and the peak-RSS preload would print the worker's figure at its exit.
    const worker = new Worker(__filename, { workerData: { out }, execArgv: [] });
    worker.on('error', (error) => process.stderr.write(`sessions-heap-frames: ${error.message}\n`));
    worker.unref();
  }
} else {
  /** @type {{ out: string }} */
  const { out } = workerData;
  const session = new inspector.Session();
  session.connectToMainThread();
  setInterval(() => {
    session.post('HeapProfiler.getSamplingProfile', (error, result) => {
      if (error === null) appendFileSync(out, `${JSON.stringify({ s: Math.round(process.uptime()), ...summarize(result.profile.head) })}\n`);
    });
  }, 2000);
}
