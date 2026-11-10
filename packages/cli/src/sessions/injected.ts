// The blocks a harness writes into a transcript on its own account: instruction files (`CLAUDE.md`, `AGENTS.md`), the memory index, skill and
// tool lists, hook-added context, environment and session context, and the system prompt of a request. Every transcript carries them, and
// they are the operator's standing instructions rather than anything typed in a session, so a raw copy holds a marker in their place:
// `[injected <kind> <hash>]`, the hash a keyed hash of the block's whitespace-normalized text. The same block gives the same hash in every
// session of a machine (books can still count which instruction set a session ran under), and the key stays on the machine.
//
// A block is replaced only where the harness puts one: a record type or attachment type it owns, a leading `<system-reminder>` of a user
// message, a `<system-reminder>` in a tool result, or the text of a meta message. What an operator typed is left to the other rules. A block the
// harness writes in a shape not listed here is not replaced until a rule covers it (docs/sessions-store.md, "What it cannot catch").
import { createHmac } from 'node:crypto';

export type Json = string | number | boolean | null | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

/** One transcript line, decoded; the same object back when nothing in it was an injected block. */
export type InjectedRule = (line: JsonObject) => JsonObject;

const isObject = (value: Json | undefined): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const MARKER = /^\[injected [a-z0-9_-]+ [0-9a-f]{12}\]$/;
// A string shorter than this is a label or a flag (`Project`, `user`), not a block.
const MIN_BLOCK = 8;
// Keys that name the record rather than hold its text: they stay readable.
const STRUCTURAL = new Set(['type', 'name', 'hookName', 'hookEvent', 'toolUseID', 'path', 'displayPath']);

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

const markerOf = (key: string, kind: string, text: string): string => `[injected ${kind} ${createHmac('sha256', key).update(normalize(text)).digest('hex').slice(0, 12)}]`;

/** Applies `change` to every string under `value`, with the key the string sits under; the same value back when nothing changed. */
const mapStrings = (value: Json, name: string, change: (text: string, name: string) => string): Json => {
  if (typeof value === 'string') return change(value, name);
  if (Array.isArray(value)) {
    const items = value.map((item) => mapStrings(item, name, change));
    return items.some((item, at) => item !== value[at]) ? items : value;
  }
  if (isObject(value)) {
    const before = Object.entries(value);
    const after = before.map(([key, item]): [string, Json] => [key, mapStrings(item, key, change)]);
    return after.some(([, item], at) => item !== before[at]?.[1]) ? Object.fromEntries(after) : value;
  }
  return value;
};

// Attachment types the harness writes to carry context or instructions to the model. A type outside this list (a queued prompt, a file the
// operator mentioned, a task status) holds what a person or a tool produced and keeps the other rules.
// Left out on purpose: the harness's fixed notices (`silent_turn_reminder`, `batching_reminder_sent`, `bash_output_audience_note`,
// `read_truncation_notice`, `date`), which are the same wording on every machine or a bare date and hold nothing the operator wrote, and agent
// output (`<task-notification>`, `<teammate-message>`), which is what an agent said and not an instruction.
// Known misses, left to the other rules: the `content` of an `away_summary` system record, the `rendered` copy of a `compact_file_reference`
// attachment (a file's text), and `<local-command-*>` blocks (the echo of a command the operator ran); `slug` and `cwd` stay readable.
const INJECTED_ATTACHMENTS: ReadonlySet<string> = new Set([
  'instructions', 'nested_memory', 'skill_listing', 'invoked_skills', 'dynamic_skill', 'agent_listing_delta', 'deferred_tools_record', 'deferred_tools_delta',
  'mcp_instructions_delta', 'prompt_snapshot', 'hook_success', 'hook_additional_context', 'hook_blocking_error', 'hook_non_blocking_error', 'hook_cancelled',
  'environment', 'session_context', 'context_sections', 'credential_org', 'model', 'output_style', 'output_style_instructions', 'command_permissions',
  'auto_mode', 'plan_mode', 'team_context',
]);

const blocksIn = (key: string, kind: string) => (text: string, name: string): string => (text.length < MIN_BLOCK || STRUCTURAL.has(name) || MARKER.test(text) ? text : markerOf(key, kind, text));

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const LEADING_REMINDERS = /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;

type TextRule = (text: string) => string;

/** The descriptions of a tool, its schema's included, become blocks; its name and the schema's keys and types stay. */
const toolDescriptions = (key: string) => (value: Json): Json =>
  mapStrings(value, 'tool', (text, name) => (name === 'description' ? blocksIn(key, 'tool-definition')(text, name) : text));

/** The text blocks of a message's content: `text` runs on the message's own text, `result` on the text of a tool result. */
const mapContent = (content: Json | undefined, text: TextRule, result: TextRule, definition: (tool: Json) => Json): Json | undefined => {
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return content;
  const items = content.map((block): Json => {
    if (!isObject(block)) return block;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      const next = text(block['text']);
      return next === block['text'] ? block : { ...block, text: next };
    }
    if (block['type'] === 'tool_result') {
      const inner = mapContent(block['content'], result, result, definition);
      return inner === block['content'] || inner === undefined ? block : { ...block, content: inner };
    }
    // A request blob also carries the loaded definition of one tool, the text its request shape holds as `shape.tools`.
    const tool = block['tool'];
    if (isObject(tool) && isObject(tool['definition'])) {
      const next = definition(tool['definition']);
      return next === tool['definition'] ? block : { ...block, tool: { ...tool, definition: next } };
    }
    return block;
  });
  return items.some((item, at) => item !== content[at]) ? items : content;
};

// Harness text a request blob of the system role carries, by what it opens with or names. The whole block is marked, under the kind (and so the hash) its
// attachment record gets, because it is the same text. First match wins. A system text with none of these forms is left to the other rules.
const SYSTEM_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bSessionStart(?::[\w-]+)? hook\b|\bhook additional context\b/, 'hook-additional-context'],
  [/following skills are available for use with the Skill tool/i, 'skill-listing'],
  [/Available agent types/i, 'agent-listing-delta'],
  [/^\s*#{1,3} MCP Server Instructions\b|following MCP servers have provided instructions/m, 'mcp-instructions-delta'],
  [/^\s*#{1,3} Environment\s*$|^\s*You have been invoked in the following environment/m, 'environment'],
  [/Contents of [^\n]*?[\\/]\.claude[\\/]rules[\\/][^\n]*\.md\b|Contents of [^\n]*?(?:CLAUDE|AGENTS|MEMORY)(?:\.local)?\.md\b/, 'instructions'],
];

// A memory file: an instruction file, the memory index, a note under a `memory` folder, or a rules file.
const MEMORY_PATH = /(?:^|[\\/])(?:CLAUDE|AGENTS|MEMORY)(?:\.local)?\.md$|[\\/]memory[\\/][^\\/]+\.md$|[\\/]\.claude[\\/]rules[\\/][^\\/]+\.md$/i;
const MEMORY_MENTION = /(?:CLAUDE|AGENTS|MEMORY)(?:\.local)?\.md\b|[\\/]memory[\\/][^\s"'`\\/]+\.md\b/i;
const CHANGED = /changed on disk|was modified/i;

/** The kind of harness text a system-role string is, or undefined: one of the forms above, or a note that a memory file changed. */
const systemKindOf = (text: string): string | undefined => {
  const form = SYSTEM_FORMS.find(([shape]) => shape.test(text));
  if (form !== undefined) return form[1];
  return MEMORY_MENTION.test(text) && CHANGED.test(text) ? 'memory-file' : undefined;
};

const systemText = (key: string): TextRule => (text) => {
  const kind = text.trim() === '' || MARKER.test(text.trim()) ? undefined : systemKindOf(text);
  return kind === undefined ? text : markerOf(key, kind, text);
};

type Position = 'typed' | 'meta' | 'blob';

const messageRule = (key: string, position: Position, known: ReadonlySet<string>): ((message: JsonObject) => JsonObject) => {
  const whole: TextRule = (text) => (text.trim() === '' || MARKER.test(text.trim()) ? text : markerOf(key, 'meta', text));
  const leading: TextRule = (text) => {
    const run = LEADING_REMINDERS.exec(text);
    return run === null ? text : `${run[0].replace(REMINDER, (block) => markerOf(key, 'system-reminder', block))}${text.slice(run[0].length)}`;
  };
  // A request blob repeats earlier messages and carries no `isMeta`: a text block that is the text of a meta message or an injected attachment
  // is marked `meta`, whatever kind its first line carries; the hash is the same, so the two lines still match on the hash.
  const repeated: TextRule = (text) => (known.has(normalize(text)) ? markerOf(key, 'meta', text) : leading(text));
  const anywhere: TextRule = (text) => text.replace(REMINDER, (block) => markerOf(key, 'system-reminder', block));
  return (message) => {
    const content = mapContent(message['content'], position === 'meta' ? whole : position === 'blob' ? repeated : leading, anywhere, toolDescriptions(key));
    return content === message['content'] || content === undefined ? message : { ...message, content };
  };
};

const withMessage = (line: JsonObject, field: string, rule: (message: JsonObject) => JsonObject, role = 'user'): JsonObject => {
  const message = line[field];
  if (!isObject(message) || message['role'] !== role) return line;
  const next = rule(message);
  return next === message ? line : { ...line, [field]: next };
};

/** The rule for a request blob of the system role: the harness's own forms first, then the text other lines repeat. */
const systemMessage = (key: string, known: ReadonlySet<string>): ((message: JsonObject) => JsonObject) => {
  const mark = systemText(key);
  const text: TextRule = (value) => {
    const next = mark(value);
    return next !== value || !known.has(normalize(value)) ? next : markerOf(key, 'meta', value);
  };
  return (message) => {
    const content = mapContent(message['content'], text, text, (tool) => tool);
    return content === message['content'] || content === undefined ? message : { ...message, content };
  };
};

const withField = (line: JsonObject, field: string, change: (value: Json) => Json): JsonObject => {
  const value = line[field];
  if (value === undefined) return line;
  const next = change(value);
  return next === value ? line : { ...line, [field]: next };
};

// Codex: a developer message is the harness talking, and a user message that opens with one of these tags is context it added. What a person typed has no tag.
const CODEX_USER_TAGS = /^\s*(<environment_context>|<user_instructions>|<guardian_tool_descriptions>|# AGENTS\.md instructions)/;
const CODEX_FIELDS = ['base_instructions', 'instructions', 'user_instructions', 'developer_instructions'] as const;

const codexKind = (text: string, fallback: string): string => {
  const tag = /^\s*<([a-z_]+)[ >]/.exec(text);
  return tag?.[1]?.replaceAll('_', '-') ?? fallback;
};

const codexMessage = (key: string, payload: JsonObject): JsonObject => {
  const role = payload['role'];
  if (role !== 'developer' && role !== 'user') return payload;
  const content = payload['content'];
  if (!Array.isArray(content)) return payload;
  const items = content.map((block): Json => {
    if (!isObject(block) || typeof block['text'] !== 'string') return block;
    const text = block['text'];
    const injected = role === 'developer' ? text.trim() !== '' : CODEX_USER_TAGS.test(text);
    if (!injected || MARKER.test(text.trim())) return block;
    return { ...block, text: markerOf(key, role === 'developer' ? codexKind(text, 'developer') : codexKind(text, 'agents-md'), text) };
  });
  return items.some((item, at) => item !== content[at]) ? { ...payload, content: items } : payload;
};

const codexFields = (key: string, payload: JsonObject): JsonObject =>
  CODEX_FIELDS.reduce((acc, name) => withField(acc, name, (value) => mapStrings(value, name, blocksIn(key, name.replaceAll('_', '-')))), payload);

const ORIGIN_TEXT = ['body', 'handback'] as const;
const HOOK_SUMMARY_FIELDS = ['hookAdditionalContext', 'hookErrors', 'hookInfos'] as const;

const textsOf = (content: Json | undefined): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : []));
};

/**
 * Adds to `known` the normalized text of what `line` holds that a request blob repeats without the flag that marked it: the text of a meta message
 * and the rendered copy of an injected attachment. The redactor runs this over a whole transcript before it marks any line.
 */
export const learnInjected = (line: JsonObject, known: Set<string>): Set<string> => {
  const add = (text: string): void => {
    if (text.trim() !== '' && !MARKER.test(text.trim())) known.add(normalize(text));
  };
  const message = line['message'];
  if (line['type'] === 'user' && line['isMeta'] === true && isObject(message) && message['role'] === 'user') textsOf(message['content']).forEach(add);
  const attachment = line['attachment'];
  const kind = isObject(attachment) ? attachment['type'] : undefined;
  if (line['type'] === 'attachment' && typeof kind === 'string' && INJECTED_ATTACHMENTS.has(kind) && line['rendered'] !== undefined) {
    mapStrings(line['rendered'], 'rendered', (text, name) => {
      if (text.length >= MIN_BLOCK && !STRUCTURAL.has(name)) add(text);
      return text;
    });
  }
  return known;
};

/** The rule for one machine: every injected block of a decoded transcript line becomes `[injected <kind> <hash>]`, hashed under `key`; `known` is what `learnInjected` collected from the transcript. */
export const injectedRule = (key: string, known: ReadonlySet<string> = new Set()): InjectedRule => {
  const userMessage = messageRule(key, 'typed', known);
  const metaMessage = messageRule(key, 'meta', known);
  const blobMessage = messageRule(key, 'blob', known);
  const systemBlob = systemMessage(key, known);
  const memory = blocksIn(key, 'memory-file');
  // A meta line's `origin` says where the injected text came from; its `body` and `handback` are that text again, while `kind` stays readable.
  const originText = (origin: Json): Json => {
    if (!isObject(origin)) return origin;
    return ORIGIN_TEXT.reduce((acc, name) => withField(acc, name, (value) => mapStrings(value, name, blocksIn(key, 'meta'))), origin);
  };
  return (line) => {
    switch (line['type']) {
      case 'user':
        return line['isMeta'] === true ? withField(withMessage(line, 'message', metaMessage), 'origin', originText) : withMessage(line, 'message', userMessage);
      case 'api-request-blob':
        return withMessage(withMessage(line, 'message', blobMessage), 'message', systemBlob, 'system');
      case 'attachment': {
        const attachment = line['attachment'];
        const kind = isObject(attachment) ? attachment['type'] : undefined;
        // A memory file the model edited or that changed on disk: the snippet (and the message it was shown in) is the file's text.
        const file = isObject(attachment) ? attachment['filename'] : undefined;
        if (kind === 'edited_text_file' && typeof file === 'string' && MEMORY_PATH.test(file)) {
          const snippet = (value: Json): Json => (isObject(value) ? withField(value, 'snippet', (text) => mapStrings(text, 'snippet', memory)) : value);
          return withField(withField(line, 'attachment', snippet), 'rendered', (value) => mapStrings(value, 'rendered', memory));
        }
        if (typeof kind !== 'string' || !INJECTED_ATTACHMENTS.has(kind)) return line;
        // The record repeats its text as the message the model was shown (`rendered`), so that is the same block again.
        const marked = (value: Json): Json => mapStrings(value, 'attachment', blocksIn(key, kind.replaceAll('_', '-')));
        return withField(withField(line, 'attachment', marked), 'rendered', marked);
      }
      case 'api-request-shape':
        return withField(line, 'shape', (shape) => {
          if (!isObject(shape)) return shape;
          return withField(withField(shape, 'system', (system) => mapStrings(system, 'system', blocksIn(key, 'system-prompt'))), 'tools', toolDescriptions(key));
        });
      case 'system':
        // The hook output a stop-hook summary carries: what a hook printed, its error text, and the command line it ran.
        if (line['subtype'] === 'stop_hook_summary') return HOOK_SUMMARY_FIELDS.reduce((acc, name) => withField(acc, name, (value) => mapStrings(value, name, blocksIn(key, 'hook-summary'))), line);
        // Any other system text is the harness speaking (a changed memory file, a notice), except the echo of a command the operator ran: that is operator output, not an instruction.
        if (line['subtype'] === 'local_command') return line;
        return withField(line, 'content', (value) => (typeof value === 'string' ? systemText(key)(value) : value));
      case 'session_meta':
      case 'turn_context':
        return withField(line, 'payload', (payload) => (isObject(payload) ? codexFields(key, payload) : payload));
      case 'response_item':
        return withField(line, 'payload', (payload) => (isObject(payload) && payload['type'] === 'message' ? codexMessage(key, payload) : payload));
      default:
        return line;
    }
  };
};
