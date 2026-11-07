// `oars telemetry report`: a user's own numbers from the spool, and, when a pool server is configured and answers, the fleet's beside them. Every test sets APPDATA to a temp folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { run, type RunDeps } from "../cli.js";
import { defaultConfigDir } from "../credentials.js";
import { harness, server, useServer } from "../test-support.js";
import { LATENCY_EDGES } from "./measures.js";
import {
  besideFleet,
  latestStore,
  ownCells,
  reportOf,
  textOf,
  type FleetCell,
  type FleetRead,
} from "./report.js";
import { appendLine } from "./spool.js";

useServer();

const NOW = Date.parse("2026-11-07T00:00:00Z");
const DAY = 86_400_000;
/** The bucket edge a latency reads as: the fleet's number and the user's are both counted in these buckets. */
const edge = (ms: number): number =>
  LATENCY_EDGES.find((one) => one >= ms) ?? 0;
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

const hook = (
  daysAgo: number,
  latencyMs: number,
  outcome: string,
  harnessVersion = "2.1.5",
  name = "pre-tool",
): string =>
  JSON.stringify({
    v: 1,
    id: "i",
    at: ago(daysAgo),
    type: "hook",
    cli: "0.4.0",
    os: "linux",
    data: { name, latencyMs, outcome, harness: "claude-code", harnessVersion },
  });
const command = (
  daysAgo: number,
  durationMs: number,
  exitCode: number,
): string =>
  JSON.stringify({
    v: 1,
    id: "i",
    at: ago(daysAgo),
    type: "command",
    cli: "0.4.0",
    os: "linux",
    data: { path: ["pool", "fetch"], flags: [], durationMs, exitCode },
  });
const store = (daysAgo: number, data: object): string =>
  JSON.stringify({
    v: 1,
    id: "i",
    at: ago(daysAgo),
    type: "store-health",
    cli: "0.4.0",
    os: "linux",
    data,
  });

/** Ten pre-tool fires 1 to 2 days ago (7 hits, 3 misses, 10 to 100 ms), one 20 days ago (1000 ms), two commands, and a store snapshot. */
const fixture = (): string[] => [
  ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, at) =>
    hook(1 + (at % 2), ms, at < 7 ? "hit" : "miss"),
  ),
  hook(20, 1000, "hit"),
  hook(2, 5, "error", "2.1.5", "stop"),
  command(1, 400, 0),
  command(2, 800, 10),
  store(3, {
    sessions: 12,
    skeletons: 11,
    unparseable: 1,
    verifyChecked: 23,
    verifyFailed: 2,
    rawBytes: 4096,
  }),
  store(25, {
    sessions: 9,
    skeletons: 9,
    unparseable: 0,
    verifyChecked: 18,
    verifyFailed: 0,
    rawBytes: 1024,
  }),
  "not json at all",
  JSON.stringify({
    type: "hook",
    at: "yesterday",
    data: { name: "pre-tool", latencyMs: 5, outcome: "hit" },
  }),
];

const cell = (
  cells: ReturnType<typeof ownCells>,
  metric: string,
  value = "claude-code/2.1.5",
): ReturnType<typeof ownCells>[number] => {
  const found = cells.find(
    (one) => one.metric === metric && one.value === value,
  );
  if (found === undefined) throw new Error(`no cell ${metric} ${value}`);
  return found;
};

describe("the user’s own numbers", () => {
  it("reads latency percentiles and a hit rate over the last 7 days from a fixture spool", () => {
    const cells = ownCells(fixture(), NOW, 7);
    expect(cell(cells, "hook.pre-tool.latency")).toMatchObject({
      kind: "latency",
      n: 10,
      p50: edge(50),
      p95: edge(100),
    });
    expect(cell(cells, "hook.pre-tool.hit")).toMatchObject({
      kind: "rate",
      n: 10,
      rate: 0.7,
    });
  });

  it("reads the last 30 days with the older fire counted, and leaves out what is older than the window", () => {
    const wide = ownCells(fixture(), NOW, 30);
    expect(cell(wide, "hook.pre-tool.latency")).toMatchObject({
      n: 11,
      p50: edge(60),
      p95: edge(1000),
    });
    expect(ownCells(fixture(), NOW, 7).some((one) => one.n === 11)).toBe(false);
  });

  it("counts a failed hook in no hit rate, and groups commands by their first name and the oars version", () => {
    const cells = ownCells(fixture(), NOW, 7);
    expect(cells.some((one) => one.metric === "hook.stop.hit")).toBe(false);
    expect(cell(cells, "hook.stop.latency")).toMatchObject({
      n: 1,
      p50: edge(5),
    });
    expect(cell(cells, "command.pool.latency", "0.4.0")).toMatchObject({
      n: 2,
      p50: edge(400),
      p95: edge(800),
    });
    expect(cell(cells, "command.pool.failure", "0.4.0")).toMatchObject({
      n: 2,
      rate: 0.5,
    });
  });

  it("skips a line that is not an event, and an event whose time is not a time", () => {
    expect(
      ownCells(
        [
          "{",
          "[]",
          "3",
          JSON.stringify({
            type: "hook",
            at: "yesterday",
            data: { name: "pre-tool", latencyMs: 5, outcome: "hit" },
          }),
        ],
        NOW,
        30,
      ),
    ).toEqual([]);
  });

  it("reads the newest store snapshot in the window", () => {
    expect(latestStore(fixture(), NOW, 30)).toMatchObject({
      sessions: 12,
      unparseable: 1,
      verifyChecked: 23,
      verifyFailed: 2,
      rawBytes: 4096,
      at: ago(3),
    });
    expect(latestStore(fixture(), NOW, 1)).toBeUndefined();
    expect(latestStore([store(1, { readFailed: 1 })], NOW, 7)).toMatchObject({
      readFailed: true,
    });
  });
});

describe("beside the fleet", () => {
  const fleet: FleetCell[] = [
    {
      metric: "hook.pre-tool.latency",
      dimension: "harnessVersion",
      value: "claude-code/2.1.5",
      kind: "latency",
      p50: 40,
      p95: 89,
    },
    {
      metric: "hook.pre-tool.hit",
      dimension: "harnessVersion",
      value: "claude-code/2.1.5",
      kind: "rate",
      p50: 0.55,
    },
  ];

  it("puts the fleet’s percentile on the cell it matches and leaves a cell with no match plainly without one", () => {
    const beside = besideFleet(ownCells(fixture(), NOW, 7), fleet);
    expect(
      beside.find((one) => one.metric === "hook.pre-tool.latency")?.fleet,
    ).toEqual({ p50: 40, p95: 89 });
    expect(
      beside.find((one) => one.metric === "hook.pre-tool.hit")?.fleet,
    ).toEqual({ p50: 0.55 });
    expect(
      beside.find((one) => one.metric === "hook.stop.latency")?.fleet,
    ).toBeUndefined();
  });

  it("prints the same numbers for a spool that is identical to a fleet cell", () => {
    const answered: FleetRead = {
      status: "answered",
      server: "https://pool.test",
      asOf: "2026-11-06",
      floor: 5,
      windows: [
        {
          days: 7,
          cells: [
            {
              metric: "hook.pre-tool.latency",
              dimension: "harnessVersion",
              value: "claude-code/2.1.5",
              kind: "latency",
              p50: edge(50),
              p95: edge(100),
            },
          ],
        },
        { days: 30, cells: [] },
      ],
    };
    const text = textOf(reportOf(fixture(), NOW, answered), "dir");
    const numbers = `p50 ${String(edge(50))} ms, p95 ${String(edge(100))} ms`;
    expect(text).toMatch(
      new RegExp(
        `hook\\.pre-tool\\.latency.*n=10  ${numbers}\\n    fleet ${numbers}\\n`,
      ),
    );
  });

  it("ends the user’s window with the day the fleet is as of, so a cell reported only today is not read against a window that cannot hold it", () => {
    const today = JSON.stringify({
      v: 1,
      id: "i",
      at: new Date(NOW + 3_600_000).toISOString(),
      type: "hook",
      cli: "0.4.0",
      os: "linux",
      data: {
        name: "stop",
        latencyMs: 5,
        outcome: "hit",
        harness: "claude-code",
        harnessVersion: "2.1.5",
      },
    });
    expect(ownCells([today], NOW, 7).map((one) => one.metric)).toContain(
      "hook.stop.latency",
    );
    expect(ownCells([today], NOW, 7, "2026-11-06")).toEqual([]);
    // The window is `days` whole UTC days ending with asOf: the day it starts on is in, the day before is out.
    const first = JSON.stringify({
      v: 1,
      id: "i",
      at: "2026-10-31T00:00:00.000Z",
      type: "hook",
      cli: "0.4.0",
      os: "linux",
      data: {
        name: "stop",
        latencyMs: 5,
        outcome: "hit",
        harness: "claude-code",
        harnessVersion: "2.1.5",
      },
    });
    const before = JSON.stringify({
      v: 1,
      id: "i",
      at: "2026-10-30T23:59:59.000Z",
      type: "hook",
      cli: "0.4.0",
      os: "linux",
      data: {
        name: "stop",
        latencyMs: 5,
        outcome: "hit",
        harness: "claude-code",
        harnessVersion: "2.1.5",
      },
    });
    expect(
      ownCells([first, before], NOW, 7, "2026-11-06").map((one) => one.n),
    ).toEqual([1, 1]);
    expect(ownCells([first, before], NOW, 7, "not-a-day")).toEqual([]);
  });

  it("puts nothing beside a cell when no fleet read answered", () => {
    expect(
      besideFleet(ownCells(fixture(), NOW, 7), undefined).every(
        (one) => one.fleet === undefined,
      ),
    ).toBe(true);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const setup = (
  env: NodeJS.ProcessEnv = {},
): { deps: RunDeps; out: string[]; dir: string } => {
  const appData = mkdtempSync(join(tmpdir(), "oars-telemetry-report-"));
  roots.push(appData);
  const made = harness({ APPDATA: appData, OARS_TELEMETRY: "", ...env });
  const dir = join(
    defaultConfigDir(made.deps.env, "win32", "C:\\unused-home"),
    "oars",
    "telemetry",
  );
  made.deps.telemetry = { dir, platform: "linux" };
  made.deps.now = () => NOW;
  for (const line of fixture()) appendLine(dir, line);
  return { deps: made.deps, out: made.out, dir };
};

describe("oars telemetry report", () => {
  it("prints the user’s own numbers with no server and no account, and says it has no fleet to put beside them", async () => {
    const made = setup();
    expect(await run(["telemetry", "report"], made.deps)).toBe(0);
    const text = made.out.join("");
    expect(text).toContain("hook.pre-tool.latency");
    expect(text).toContain(`p50 ${String(edge(50))} ms`);
    expect(text).toMatch(/70%/);
    expect(text).toContain(
      "No pool server is configured (OARS_POOL_URL), so these are your numbers only.",
    );
    expect(text).not.toContain("fleet p50");
  });

  it("prints the same numbers as one document with --json", async () => {
    const made = setup();
    expect(await run(["telemetry", "report", "--json"], made.deps)).toBe(0);
    const document: unknown = JSON.parse(made.out.join(""));
    expect(document).toMatchObject({
      ok: true,
      step: "telemetry",
      fleet: { status: "not-configured" },
    });
    expect(JSON.stringify(document)).toContain(`"p50":${String(edge(50))}`);
  });

  it("prints the fleet’s percentile beside the user’s own when the server answers, and says when a cell has no fleet number", async () => {
    const made = setup({ OARS_POOL_URL: "https://pool.test" });
    let asked:
      | { auth: string | null; cookie: string | null; query: string }
      | undefined;
    server.use(
      http.get("https://pool.test/v1/telemetry/fleet", ({ request }) => {
        asked = {
          auth: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          query: new URL(request.url).search,
        };
        return HttpResponse.json({
          asOf: "2026-11-06",
          floor: 5,
          windows: [
            {
              days: 7,
              cells: [
                {
                  metric: "hook.pre-tool.latency",
                  dimension: "harnessVersion",
                  value: "claude-code/2.1.5",
                  kind: "latency",
                  p50: 34,
                  p95: 89,
                },
              ],
            },
            { days: 30, cells: [] },
          ],
        });
      }),
    );
    expect(await run(["telemetry", "report"], made.deps)).toBe(0);
    const text = made.out.join("");
    expect(text).toMatch(
      /hook\.pre-tool\.latency.*\n.*fleet p50 34 ms, p95 89 ms/,
    );
    expect(text).toContain(
      "fleet: not served (fewer than 5 installs report this)",
    );
    expect(text).toContain("Fleet numbers are as of 2026-11-06");
    // The read carries nothing of the user's: no credential, no id, no spool.
    expect(asked).toEqual({ auth: null, cookie: null, query: "" });
  });

  it("says plainly when the server does not answer, and still prints the user’s numbers", async () => {
    const made = setup({ OARS_POOL_URL: "https://pool.test" });
    server.use(
      http.get("https://pool.test/v1/telemetry/fleet", () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    expect(await run(["telemetry", "report"], made.deps)).toBe(0);
    const text = made.out.join("");
    expect(text).toContain(
      "The pool server at https://pool.test did not give a fleet read (HTTP 404), so these are your numbers only.",
    );
    expect(text).toContain(`p50 ${String(edge(50))} ms`);
  });

  it("says so when the answer is not a fleet read, the server cannot be reached, or the setting is not a server", async () => {
    const wrong = setup({ OARS_POOL_URL: "https://pool.test" });
    server.use(
      http.get("https://pool.test/v1/telemetry/fleet", () =>
        HttpResponse.json({ windows: "no" }),
      ),
    );
    await run(["telemetry", "report", "--json"], wrong.deps);
    expect(JSON.parse(wrong.out.join(""))).toMatchObject({
      fleet: {
        status: "unavailable",
        reason: "the answer is not a fleet read",
      },
    });

    const down = setup({ OARS_POOL_URL: "https://pool.test" });
    server.use(
      http.get("https://pool.test/v1/telemetry/fleet", () =>
        HttpResponse.error(),
      ),
    );
    await run(["telemetry", "report", "--json"], down.deps);
    expect(JSON.parse(down.out.join(""))).toMatchObject({
      fleet: { status: "unavailable" },
    });

    const bad = setup({ OARS_POOL_URL: "ftp://pool.test" });
    expect(await run(["telemetry", "report", "--json"], bad.deps)).toBe(0);
    expect(JSON.parse(bad.out.join(""))).toMatchObject({
      fleet: { status: "unavailable" },
    });
  });

  it("prints the empty case plainly", async () => {
    const made = setup();
    for (const path of [join(made.dir, "events.jsonl")]) rmSync(path);
    expect(await run(["telemetry", "report"], made.deps)).toBe(0);
    expect(made.out.join("")).toContain("Nothing is measured in the spool yet");
  });
});
