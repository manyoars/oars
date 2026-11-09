// What a transcript shows of a session's setup, its tool funnel, and its trust shape (the capture half of the pool vocabulary). Read from the
// transcript only: never today's config or instruction files, because a file read now is not that session's setup. A field the transcript does not
// hold is absent, never guessed. Counts, names, and sizes only: no instruction text, hook command, or tool description is kept. Class A, local; nothing
// here is projected or uploaded.
//
// One collector per transcript, fed line by line by `captureSession`. It reads the Claude Code line shapes (a census of 2.1.312 to 2.1.318) and
// one neutral line an adapter may write for a harness whose records are not Claude-shaped (`oars-tools`).

import { loadedInstructionsOf } from './load-status.js';
import type { Harness, LoadedInstructions } from './schema.js';

type Obj = { [key: string]: unknown };

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []);

/** The harness's tool-rejection results, both worded for the operator declining: a classifier or hook denial is policy, and the model carries on. */
export const REJECTED_RE = /^The user doesn't want to (?:proceed with this tool use|take this action)/;
/** The harness writes this as a user line when the operator cut a turn short; a rejection is followed by it too, so it is not a second interrupt. The Codex reader writes it for a `turn_aborted` with reason `interrupted` (CAPTURE 23). */
export const INTERRUPT_MARKER = '[Request interrupted by user';
/**
 * A decline in the fixed text Codex or Gemini CLI writes for a call the operator refused: Codex's `exec command rejected by user` and `patch rejected by user` (events.rs:456-457), and Gemini's `[Operation Cancelled]`
 * followed by a user cancel or denial. The text is the whole match, never a guess from other wording; `errorCodeOf` classes the same lines `user-rejected`, and the `user-stop` bucket reads them (EXTRACTOR 15).
 */
export const DECLINED_RE = /^(?:(?:exec command|patch) rejected by user\s*$|\[Operation Cancelled\] (?:Reason: )?(?:User (?:cancelled|denied)|Operation cancelled by user))/;
/** A policy refusal: the permission rules or the auto-mode classifier (`Permission ... has been denied`), or a hook (`PreToolUse:Bash hook error`). Not the human's. */
const DENIED_RE = /^(?:Permission (?:to use .{1,200}?|for this action) has been denied|[A-Za-z]+:[^\s]+ hook error|Hook [A-Za-z]+:[^\s]+ denied)/;
/** A plugin's MCP server names its tools `mcp__plugin_<plugin>_<server>__<tool>`; that is the only evidence of an installed plugin read here.
 * The name stops at its first `_`, since the tool name cannot say where the plugin ends and the server begins: `mcp__plugin_my_plugin_srv__t` reads as `my`. */
const PLUGIN_TOOL_RE = /^mcp__plugin_([A-Za-z0-9-]+)_/;

/** A hook of the `Stop` event, named `Stop` or `Stop:<matcher>`. */
const STOP_HOOK_RE = /^Stop(?::|$)/;

/** An adapter's neutral line naming tools: `offered` and `loaded` are arrays of tool names. */
export const SHAPE_TOOLS_LINE = 'oars-tools';

/** The permission modes each harness documents; any other value is stored as `other` (spec row `permissionMode`). Keyed by harness so a new one must add its entry. */
const PERMISSION_MODES: { readonly [harness in Harness]: ReadonlySet<string> } = {
  'claude-code': new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']),
  codex: new Set(['untrusted', 'on-failure', 'on-request', 'never', 'granular']),
  // Cursor's, Copilot's, and Gemini CLI's readers record no permission mode, so no value is documented to keep.
  copilot: new Set(),
  // VS Code Copilot Chat's reader records no permission mode either.
  'vscode-copilot': new Set(),
  gemini: new Set(),
  cursor: new Set(),
  // Grok Build's reader reads no mode (its `current_mode_update` carries one, but this reader does not read it), so no value is documented to keep.
  grok: new Set(),
  // OpenCode's reader reads no permission mode (a session records the agent, not a mode), so no value is documented to keep.
  opencode: new Set(),
  // Pi has no permission modes: its tools run as the user, and a session records none.
  pi: new Set(),
  // A trace carries no permission mode.
  otel: new Set(),
};

/**
 * Which trust counts a harness's transcript records completely. A zero is stored only where the harness would have shown the event; where it would not,
 * the count is absent, because zero would claim a human never stopped it. Keyed by harness so a new one must decide.
 */
const COMPLETE: { readonly [harness in Harness]: { readonly interrupts: boolean; readonly rejections: boolean; readonly denials: boolean; readonly timing: boolean } } = {
  'claude-code': { interrupts: true, rejections: true, denials: true, timing: true },
  codex: { interrupts: true, rejections: false, denials: false, timing: true },
  // Copilot's reader writes the prompts and the agent's lines with their times (so the runs are real), and reads no `abort`, tool outcome refusal, or hook denial.
  copilot: { interrupts: false, rejections: false, denials: false, timing: true },
  // VS Code Copilot Chat's reader writes the prompts and the responses with their times (so the runs are real) and reads a refusal as a tool error, not as a counted one; it reads no interrupt or hook denial count.
  'vscode-copilot': { interrupts: false, rejections: false, denials: false, timing: true },
  // Gemini CLI's reader writes each message with its own time (so the runs are real), and reads no interrupt, refusal, or denial: the chat file holds a cancelled call as an error and no more.
  gemini: { interrupts: false, rejections: false, denials: false, timing: true },
  cursor: { interrupts: false, rejections: false, denials: false, timing: false },
  // Grok Build's reader writes the prompts and replies with their line times (seconds), and reads no cancel, tool refusal, or hook denial.
  grok: { interrupts: false, rejections: false, denials: false, timing: true },
  // OpenCode's reader writes each message with its own time (so the runs are real) and reads no interrupt, refusal, or denial: a refused or aborted tool is an error state with a message.
  opencode: { interrupts: false, rejections: false, denials: false, timing: true },
  // Pi's reader writes the prompts and the responses with their entry times, and reads no interrupt, refusal, or denial: an aborted call is a tool error and no more.
  pi: { interrupts: false, rejections: false, denials: false, timing: true },
  // A trace's spans carry their own start and end times; it records no interrupt, refusal, or denial count.
  otel: { interrupts: false, rejections: false, denials: false, timing: true },
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
  /** Distinct hooks seen to fire, by the name the harness gives each, a floor; never the command. */
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
  loadedInstructions?: LoadedInstructions;
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
  turn(kind: 'human' | 'agent' | 'none', seconds: number | undefined, uuid?: string): void;
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

/** `stored` is the stored form of a tool name (`storedToolName`): every name this keeps is a tool name, an MCP server's part redacted. */
export const createShape = (harness: Harness, stored: (tool: string) => string, options: { timing: boolean }): ShapeCollector => {
  const complete = COMPLETE[harness];
  const modes = new Map<string, number>();
  /** Hooks seen to fire, by the name the harness gives them (`PreToolUse:Bash`, `Stop`). */
  const hooks = new Set<string>();
  /** The commands a `stop_hook_summary` lists: counted only when no line of a `Stop` hook was seen, since that line and the summary are the same hooks. */
  const stopCommands = new Set<string>();
  let stopSeen = false;
  const memory = new Map<string, number>();
  let instructionFiles: { path: string; type: string }[] | undefined;
  let cwd: string | undefined;
  const plugins = new Set<string>();
  /** Every name offered or removed, in order: the last event on a name decides which side it ends on. */
  const standing = new Map<string, 'offered' | 'removed'>();
  const loaded = new Set<string>();
  const events: TrustEvent[] = [];
  const open = new Map<string, string>();
  /** Every tool call id that has had its result, so a replayed call or result is neither re-opened nor counted twice. */
  const finished = new Set<string>();
  /** Human turns already taken, by uuid: a resume replays them. */
  const humans = new Set<string>();
  const markers = new Set<string>();
  let rejectedLast = false;
  // The human refused a call: the run ended at the agent's last line before it, and what the agent does after the refusal waits for the next human turn.
  let declined = false;
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
    // The `mcp__plugin_<plugin>_` naming is Claude Code's; another harness's tool of that shape is not evidence of a plugin.
    // Read from the stored form, so a plugin named with a token reads as none rather than as the token.
    const plugin = harness === 'claude-code' && tool.startsWith('mcp__plugin_') ? pluginOf(stored(tool)) : undefined;
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
    // The turn ended, so no call is still in flight: a later marker must not name this one.
    open.clear();
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
    if (id === undefined || finished.has(id)) return;
    finished.add(id);
    const tool = open.get(id) ?? null;
    open.delete(id);
    if (block.is_error !== true) return;
    const line = firstLine(block.content);
    if (REJECTED_RE.test(line)) {
      if (complete.rejections) {
        rejectedLast = true;
        declined = true;
      }
      event('rejection', tool, at.prompt);
    } else if (DENIED_RE.test(line)) event('denial', tool, at.prompt);
  };

  const attachment = (a: Obj): void => {
    const kind = str(a.type);
    if (kind === 'deferred_tools_delta') {
      offer(names(a.addedNames));
      remove(names(a.removedNames));
    } else if (kind === 'hook_success' || kind === 'hook_additional_context' || kind === 'hook_blocking_error') {
      const name = str(a.hookName);
      if (name !== undefined && name !== '') {
        hooks.add(name);
        if (STOP_HOOK_RE.test(name)) stopSeen = true;
      }
    } else if (kind === 'instructions' && instructionFiles === undefined && Array.isArray(a.files)) {
      // The first record only: a resumed session logs the set again, and the snapshot it joins with is that session's first.
      instructionFiles = a.files.flatMap((file: unknown) => {
        if (!isObj(file)) return [];
        const path = str(file.path);
        return path === undefined ? [] : [{ path, type: str(file.type) ?? '' }];
      });
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
      // A sidechain line is a subagent's own, not the main session's setup.
      if (at.side) return;
      cwd ??= str(line.cwd);
      const type = str(line.type);
      if (type === 'permission-mode') mode(line.permissionMode);
      else if (type === 'api-request-shape') {
        // The eager tool list the request sent: names only. `shape.system` holds the system prompt and a tool's description its text, so neither is touched.
        const shape = isObj(line.shape) ? line.shape : undefined;
        if (Array.isArray(shape?.tools)) offer(names(shape.tools.map((tool: unknown) => (isObj(tool) ? tool.name : undefined))));
      } else if (type === SHAPE_TOOLS_LINE) {
        offer(names(line.offered));
        load(names(line.loaded));
      } else if (type === 'attachment') {
        if (isObj(line.attachment)) attachment(line.attachment);
      } else if (type === 'system' && line.subtype === 'stop_hook_summary') {
        if (Array.isArray(line.hookInfos)) for (const info of line.hookInfos) if (isObj(info) && str(info.command) !== undefined) stopCommands.add(str(info.command) ?? '');
      } else if ((type === 'user' || type === 'assistant') && isObj(line.message)) {
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
            if (id !== undefined && name !== undefined && !open.has(id) && !finished.has(id)) open.set(id, name);
          } else if (block.type === 'tool_result') result(block, at);
        }
      }
    },

    turn(kind, seconds, uuid) {
      if (kind === 'human') {
        // A resume replays earlier lines: a human turn already taken is not a new one.
        if (uuid !== undefined) {
          if (humans.has(uuid)) return;
          humans.add(uuid);
        }
        // The operator spoke again: nothing is still in flight, and a rejection before this is not what a later marker follows.
        open.clear();
        rejectedLast = false;
      }
      // The line after a rejection ends the run; a human turn does that anyway, so it falls through to start the next one.
      const afterRejection = declined && kind !== 'human';
      declined = false;
      if (!timing) return;
      if (afterRejection) {
        close();
        return;
      }
      // A human turn with no usable time still ends the run before it: the agent lines after it are not that run's.
      if (kind === 'human') {
        close();
        start = seconds;
      } else if (kind === 'agent' && seconds !== undefined && start !== undefined && seconds >= start && (end === undefined || seconds > end)) end = seconds;
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
      const hookTotal = hooks.size + (stopSeen ? 0 : stopCommands.size);
      if (hookTotal > 0) setup.hookCount = hookTotal;
      if (memory.size > 0) setup.instructionBytes = [...memory.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (Object.keys(setup).length > 0) out.setup = setup;
      if (instructionFiles !== undefined && cwd !== undefined) out.loadedInstructions = loadedInstructionsOf(instructionFiles, cwd);

      const funnel: SessionFunnel = {};
      // Two names that redact to one form are one tool, as `tools` keys it.
      const sideOf = (which: 'offered' | 'removed'): string[] => [...new Set([...standing].filter(([, side]) => side === which).map(([name]) => stored(name)))].sort();
      const offered = sideOf('offered');
      const removed = sideOf('removed');
      if (offered.length > 0) funnel.offered = offered;
      if (loaded.size > 0) funnel.loaded = [...new Set([...loaded].map(stored))].sort();
      if (removed.length > 0) funnel.removed = removed;
      if (Object.keys(funnel).length > 0) out.funnel = funnel;

      const trust: SessionTrust = {};
      if (complete.interrupts) trust.interrupts = counts.interrupts;
      if (complete.rejections) trust.rejections = counts.rejections;
      if (complete.denials) trust.denials = counts.denials;
      const kept = events.filter((item) => (item.event === 'interrupt' ? complete.interrupts : item.event === 'rejection' ? complete.rejections : complete.denials));
      if (kept.length > 0) trust.trustEvent = kept.map((item) => ({ ...item, tool: item.tool === null ? null : stored(item.tool) }));
      if (runs.length > 0) trust.unattendedRun = runs;
      if (Object.keys(trust).length > 0) out.trust = trust;
      return out;
    },
  };
};
