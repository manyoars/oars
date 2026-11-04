// What a transcript shows of a session's setup, its tool funnel, and its trust shape (t815, the capture half of pool vocabulary Brief 3). Read from the
// transcript only: never today's config or instruction files, because a file read now is not that session's setup. A field the transcript does not
// hold is absent, never guessed. Counts and sizes only: no instruction text, hook command, or tool description is kept. Class A, local; nothing
// here is projected or uploaded.
//
// One collector per transcript, fed line by line by `captureSession`. It reads the Claude Code line shapes (t816's census of 2.1.312 to 2.1.318) and
// two neutral lines an adapter may write for a harness whose records are not Claude-shaped (`oars-tools`, `oars-interrupt`).

import type { Harness } from './schema.js';

type Obj = { [key: string]: unknown };

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []);

/** The harness's tool-rejection results, both worded for the operator declining: a classifier or hook denial is policy, and the model carries on. */
export const REJECTED_RE = /^The user doesn't want to (?:proceed with this tool use|take this action)/;
/** The harness writes this as a user line when the operator cut a turn short; a rejection is followed by it too, so it is not a second interrupt. */
export const INTERRUPT_MARKER = '[Request interrupted by user';
/** A policy refusal: the permission rules or the auto-mode classifier (`Permission ... has been denied`), or a hook (`PreToolUse:Bash hook error`). Not the human's. */
const DENIED_RE = /^(?:Permission (?:to use .{1,200}?|for this action) has been denied|[A-Za-z]+:[^\s]+ hook error|Hook [A-Za-z]+:[^\s]+ denied)/;
/** A plugin's MCP server names its tools `mcp__plugin_<plugin>_<server>__<tool>`; that is the only evidence of an installed plugin read here. */
const PLUGIN_TOOL_RE = /^mcp__plugin_([A-Za-z0-9-]+)_/;

/** An adapter's neutral line naming tools: `offered`, `loaded`, and `removed` are arrays of tool names. */
export const SHAPE_TOOLS_LINE = 'oars-tools';
/** An adapter's neutral line for a turn the operator cut short, for a harness whose record is not a Claude marker line. */
export const SHAPE_INTERRUPT_LINE = 'oars-interrupt';

/** The permission modes each harness documents; any other value is stored as `other` (spec row `permissionMode`). Keyed by harness so a new one must add its entry. */
const PERMISSION_MODES: { readonly [harness in Harness]: ReadonlySet<string> } = {
  'claude-code': new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']),
  codex: new Set(['untrusted', 'on-failure', 'on-request', 'never', 'granular']),
  cursor: new Set(),
};

/**
 * Which trust counts a harness's transcript records completely. A zero is stored only where the harness would have shown the event; where it would not,
 * the count is absent, because zero would claim a human never stopped it. Keyed by harness so a new one must decide.
 */
const COMPLETE: { readonly [harness in Harness]: { readonly interrupts: boolean; readonly rejections: boolean; readonly denials: boolean; readonly timing: boolean } } = {
  'claude-code': { interrupts: true, rejections: true, denials: true, timing: true },
  codex: { interrupts: true, rejections: false, denials: false, timing: true },
  cursor: { interrupts: false, rejections: false, denials: false, timing: false },
};

export type TrustEventKind = 'interrupt' | 'rejection' | 'denial';

/** One stop, with the tool in flight (null when none is known) and the prompt it fell in (null before the first). */
export interface TrustEvent {
  event: TrustEventKind;
  tool: string | null;
  prompt: number | null;
}

/** The setup the session ran with. A field the transcript does not hold is absent. */
export interface SessionSetup {
  /** The mode most of the session ran in: the harness's documented value, else `other`. */
  permissionMode?: string;
  /** Plugins evidenced by a tool named after them, sorted. */
  plugins?: string[];
  /** Distinct hooks seen to fire (event and command), a floor; never the command. */
  hookCount?: number;
  /** Bytes of instruction files the harness loaded mid-session, a floor: the opening instruction files are in a blob capture skips. */
  instructionBytes?: number;
}

/** The tool names at each stage a transcript shows, sorted. `called` and `worked` are the session's tool calls and their status, already captured. */
export interface SessionFunnel {
  /** Offered and not since removed. */
  offered?: string[];
  /** Pulled into the context by a tool search. */
  loaded?: string[];
  /** Offered and then removed, and not offered again. */
  removed?: string[];
}

/** How far the session was trusted to run alone. The exact value is kept; the buckets belong to the projection. */
export interface SessionTrust {
  interrupts?: number;
  /** The human declined a tool call. */
  rejections?: number;
  /** Policy refused it: permission rules, the classifier, or a hook. */
  denials?: number;
  trustEvent?: TrustEvent[];
  /** Minutes the agent ran alone after each human turn: from the turn to the agent's last line before the next human turn, two decimals. */
  unattendedRun?: number[];
}

export interface SessionShape {
  setup?: SessionSetup;
  funnel?: SessionFunnel;
  trust?: SessionTrust;
}

/** Where a line sits, for the parts of the shape that depend on it. */
export interface LineContext {
  /** A sidechain line in a main transcript: a subagent's own, not read here. */
  side: boolean;
  /** The prompt the line falls in. */
  prompt: number | null;
}

export interface ShapeCollector {
  read(line: Obj, at: LineContext): void;
  /** A turn: `human` opens a run of the agent alone and closes the last; `agent` is the agent (or an automated turn) working; `none` is neither. */
  turn(kind: 'human' | 'agent' | 'none', seconds: number | undefined): void;
  finish(): SessionShape;
}

const firstText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) if (isObj(block) && block.type === 'text') return str(block.text) ?? '';
  return '';
};

const firstLine = (content: unknown): string => firstText(content).trimStart().split('\n', 1)[0] ?? '';

const pluginOf = (tool: string): string | undefined => PLUGIN_TOOL_RE.exec(tool)?.[1];

export const createShape = (harness: Harness, redact: (text: string) => string, options: { timing: boolean } = { timing: true }): ShapeCollector => {
  const complete = COMPLETE[harness];
  const modes = new Map<string, number>();
  const hooks = new Set<string>();
  const memory = new Map<string, number>();
  const plugins = new Set<string>();
  /** Every name offered or removed, in order: the last event on a name decides which side it ends on. */
  const standing = new Map<string, 'offered' | 'removed'>();
  const loaded = new Set<string>();
  const events: TrustEvent[] = [];
  const open = new Map<string, string>();
  const settled = new Set<string>();
  const markers = new Set<string>();
  let rejectedLast = false;
  const counts = { interrupts: 0, rejections: 0, denials: 0 };
  const runs: number[] = [];
  let start: number | undefined;
  let end: number | undefined;
  const timing = options.timing && complete.timing;

  const mode = (raw: unknown): void => {
    const value = str(raw);
    if (value === undefined || value === '') return;
    const kept = PERMISSION_MODES[harness].has(value) ? value : 'other';
    modes.set(kept, (modes.get(kept) ?? 0) + 1);
  };
  const noted = (tool: string): void => {
    const plugin = pluginOf(tool);
    if (plugin !== undefined) plugins.add(plugin);
  };
  const offer = (list: string[]): void => {
    for (const name of list) {
      standing.set(name, 'offered');
      noted(name);
    }
  };
  const remove = (list: string[]): void => {
    for (const name of list) {
      standing.set(name, 'removed');
      noted(name);
    }
  };
  const load = (list: string[]): void => {
    for (const name of list) {
      loaded.add(name);
      noted(name);
    }
  };
  const event = (kind: TrustEventKind, tool: string | null, prompt: number | null): void => {
    if (kind === 'interrupt') counts.interrupts += 1;
    else if (kind === 'rejection') counts.rejections += 1;
    else counts.denials += 1;
    events.push({ event: kind, tool, prompt });
  };
  const interrupt = (tool: string | null, prompt: number | null): void => {
    if (rejectedLast) {
      rejectedLast = false;
      return;
    }
    event('interrupt', tool, prompt);
  };
  /** The tool the harness was still waiting on: the last call with no result. */
  const inFlight = (): string | null => [...open.values()].at(-1) ?? null;

  const result = (block: Obj, at: LineContext): void => {
    const id = str(block.tool_use_id);
    // A tool_reference block is the tool search's answer: those tools are now loaded.
    if (Array.isArray(block.content)) {
      for (const inner of block.content) if (isObj(inner) && inner.type === 'tool_reference') load(names([inner.tool_name]));
    }
    if (id === undefined) return;
    const tool = open.get(id) ?? null;
    open.delete(id);
    if (block.is_error !== true || settled.has(id)) return;
    settled.add(id);
    const line = firstLine(block.content);
    if (REJECTED_RE.test(line)) {
      rejectedLast = true;
      event('rejection', tool, at.prompt);
    } else if (DENIED_RE.test(line)) event('denial', tool, at.prompt);
  };

  const attachment = (a: Obj): void => {
    const kind = str(a.type);
    if (kind === 'deferred_tools_delta') {
      offer(names(a.addedNames));
      remove(names(a.removedNames));
    } else if (kind === 'hook_success') {
      const command = str(a.command);
      if (command !== undefined) hooks.add(`${str(a.hookEvent) ?? ''}\u0000${command}`);
    } else if (kind === 'hook_blocking_error') {
      const command = isObj(a.blockingError) ? str(a.blockingError.command) : undefined;
      if (command !== undefined) hooks.add(`${str(a.hookEvent) ?? ''}\u0000${command}`);
    } else if (kind === 'nested_memory' && isObj(a.content) && typeof a.content.content === 'string') {
      // The same file comes again when the harness reloads it, so one path counts once.
      const key = str(a.path) ?? str(a.content.path) ?? `#${String(memory.size)}`;
      if (!memory.has(key)) memory.set(key, Buffer.byteLength(a.content.content));
    }
  };

  const close = (): void => {
    if (start !== undefined) runs.push(Math.round((((end ?? start) - start) / 60) * 100) / 100);
    start = undefined;
    end = undefined;
  };

  return {
    read(line, at) {
      const type = str(line.type);
      if (type === 'permission-mode') mode(line.permissionMode);
      else if (type === 'api-request-shape') {
        // The eager tool list the request sent: names only. `shape.system` holds the system prompt and a tool's description its text, so neither is touched.
        const shape = isObj(line.shape) ? line.shape : undefined;
        if (Array.isArray(shape?.tools)) offer(names(shape.tools.map((tool: unknown) => (isObj(tool) ? tool.name : undefined))));
      } else if (type === SHAPE_TOOLS_LINE) {
        offer(names(line.offered));
        remove(names(line.removed));
        load(names(line.loaded));
      } else if (type === SHAPE_INTERRUPT_LINE) interrupt(inFlight(), at.prompt);
      else if (type === 'attachment') {
        if (isObj(line.attachment)) attachment(line.attachment);
      } else if (type === 'system' && line.subtype === 'stop_hook_summary') {
        if (Array.isArray(line.hookInfos)) for (const info of line.hookInfos) if (isObj(info) && str(info.command) !== undefined) hooks.add(`Stop\u0000${str(info.command) ?? ''}`);
      } else if ((type === 'user' || type === 'assistant') && !at.side && isObj(line.message)) {
        if (type === 'user') mode(line.permissionMode);
        const content = line.message.content;
        if (type === 'user' && firstText(content).startsWith(INTERRUPT_MARKER)) {
          const uuid = str(line.uuid);
          if (uuid === undefined || !markers.has(uuid)) interrupt(inFlight(), at.prompt);
          if (uuid !== undefined) markers.add(uuid);
        }
        if (type === 'assistant') rejectedLast = false;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isObj(block)) continue;
          if (block.type === 'tool_use') {
            const id = str(block.id);
            const name = str(block.name);
            if (name !== undefined) noted(name);
            if (id !== undefined && name !== undefined && !open.has(id)) open.set(id, name);
          } else if (block.type === 'tool_result') result(block, at);
        }
      }
    },

    turn(kind, seconds) {
      if (!timing || seconds === undefined) return;
      if (kind === 'human') {
        close();
        start = seconds;
      } else if (kind === 'agent' && start !== undefined && (end === undefined || seconds > end)) end = seconds;
    },

    finish() {
      close();
      const out: SessionShape = {};
      const setup: SessionSetup = {};
      let best = 0;
      for (const [value, count] of modes) {
        if (count > best) {
          best = count;
          setup.permissionMode = value;
        }
      }
      if (plugins.size > 0) setup.plugins = [...plugins].sort();
      if (hooks.size > 0) setup.hookCount = hooks.size;
      if (memory.size > 0) setup.instructionBytes = [...memory.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (Object.keys(setup).length > 0) out.setup = setup;

      const funnel: SessionFunnel = {};
      const sideOf = (which: 'offered' | 'removed'): string[] => [...standing].filter(([, side]) => side === which).map(([name]) => redact(name)).sort();
      const offered = sideOf('offered');
      const removed = sideOf('removed');
      if (offered.length > 0) funnel.offered = offered;
      if (loaded.size > 0) funnel.loaded = [...loaded].map(redact).sort();
      if (removed.length > 0) funnel.removed = removed;
      if (Object.keys(funnel).length > 0) out.funnel = funnel;

      const trust: SessionTrust = {};
      if (complete.interrupts) trust.interrupts = counts.interrupts;
      if (complete.rejections) trust.rejections = counts.rejections;
      if (complete.denials) trust.denials = counts.denials;
      const kept = events.filter((item) => (item.event === 'interrupt' ? complete.interrupts : item.event === 'rejection' ? complete.rejections : complete.denials));
      if (kept.length > 0) trust.trustEvent = kept.map((item) => ({ ...item, tool: item.tool === null ? null : redact(item.tool) }));
      if (runs.length > 0) trust.unattendedRun = runs;
      if (Object.keys(trust).length > 0) out.trust = trust;
      return out;
    },
  };
};
