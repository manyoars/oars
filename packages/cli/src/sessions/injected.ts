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

/** The text blocks of a message's content: `text` runs on the message's own text, `result` on the text of a tool result. */
const mapContent = (content: Json | undefined, text: TextRule, result: TextRule): Json | undefined => {
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return content;
  const items = content.map((block): Json => {
    if (!isObject(block)) return block;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      const next = text(block['text']);
      return next === block['text'] ? block : { ...block, text: next };
    }
    if (block['type'] === 'tool_result') {
      const inner = mapContent(block['content'], result, result);
      return inner === block['content'] || inner === undefined ? block : { ...block, content: inner };
    }
    return block;
  });
  return items.some((item, at) => item !== content[at]) ? items : content;
};

const messageRule = (key: string, meta: boolean): ((message: JsonObject) => JsonObject) => {
  const whole: TextRule = (text) => (text.trim() === '' || MARKER.test(text.trim()) ? text : markerOf(key, 'meta', text));
  const leading: TextRule = (text) => {
    const run = LEADING_REMINDERS.exec(text);
    return run === null ? text : `${run[0].replace(REMINDER, (block) => markerOf(key, 'system-reminder', block))}${text.slice(run[0].length)}`;
  };
  const anywhere: TextRule = (text) => text.replace(REMINDER, (block) => markerOf(key, 'system-reminder', block));
  return (message) => {
    const content = mapContent(message['content'], meta ? whole : leading, anywhere);
    return content === message['content'] || content === undefined ? message : { ...message, content };
  };
};

const withMessage = (line: JsonObject, field: string, rule: (message: JsonObject) => JsonObject): JsonObject => {
  const message = line[field];
  if (!isObject(message) || message['role'] !== 'user') return line;
  const next = rule(message);
  return next === message ? line : { ...line, [field]: next };
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

/** The rule for one machine: every injected block of a decoded transcript line becomes `[injected <kind> <hash>]`, hashed under `key`. */
export const injectedRule = (key: string): InjectedRule => {
  const userMessage = messageRule(key, false);
  const metaMessage = messageRule(key, true);
  return (line) => {
    switch (line['type']) {
      case 'user':
        return withMessage(line, 'message', line['isMeta'] === true ? metaMessage : userMessage);
      case 'api-request-blob':
        return withMessage(line, 'message', userMessage);
      case 'attachment': {
        const attachment = line['attachment'];
        const kind = isObject(attachment) ? attachment['type'] : undefined;
        if (typeof kind !== 'string' || !INJECTED_ATTACHMENTS.has(kind)) return line;
        // The record repeats its text as the message the model was shown (`rendered`), so that is the same block again.
        const marked = (value: Json): Json => mapStrings(value, 'attachment', blocksIn(key, kind.replaceAll('_', '-')));
        return withField(withField(line, 'attachment', marked), 'rendered', marked);
      }
      case 'api-request-shape':
        return withField(line, 'shape', (shape) => {
          if (!isObject(shape)) return shape;
          const described = (text: string, name: string): string => (name === 'description' ? blocksIn(key, 'tool-definition')(text, name) : text);
          return withField(withField(shape, 'system', (system) => mapStrings(system, 'system', blocksIn(key, 'system-prompt'))), 'tools', (tools) => mapStrings(tools, 'tools', described));
        });
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
