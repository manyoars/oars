// The canonical action of a tool call (t755, recall spec Section 2.2). Every harness names its tools differently, so one table per adapter
// maps its native names onto one closed list, and a step reads alike in any harness. A new adapter adds a table here and changes nothing in the
// extractor. A native name no table lists becomes `other`, and its name stays out of class P (`LITERAL`): the tool record keeps it, class A.

import { LITERAL } from './public-vocabulary.js';
import type { Harness } from './schema.js';

export const CANONICAL_ACTIONS = [
  'file.read',
  'file.edit',
  'file.write',
  'file.search',
  'shell.exec',
  'web.search',
  'web.fetch',
  'mcp.call',
  'skill.run',
  'agent.spawn',
  'plan.update',
  'ask.user',
  'recall.pull',
  'recall.push',
  'other',
] as const;
export type CanonicalAction = (typeof CANONICAL_ACTIONS)[number];

export interface ActionTable {
  /** Native name to action. A row may say `other`: that is a known public name with no canonical action, so it keeps its name. */
  rows: { readonly [native: string]: CanonicalAction };
  /** How this harness spells an MCP call, with named groups `server` and `tool`; null when it has no such calls. */
  mcp: RegExp | null;
  /** Whether that spelling marks where the server name ends. One that cannot may have read a private server's name as the tool, so the tool stays out of class P. */
  toolDelimited: boolean;
  /** Native shell tool to the shell it runs, for the frame; a tool not listed does not say which shell it is. */
  shells: { readonly [native: string]: string };
}

export const ACTION_TABLES: { readonly [harness in Harness]: ActionTable } = {
  'claude-code': {
    rows: {
      Read: 'file.read',
      Edit: 'file.edit',
      MultiEdit: 'file.edit',
      NotebookEdit: 'file.edit',
      Write: 'file.write',
      Grep: 'file.search',
      Glob: 'file.search',
      LSP: 'file.search',
      Bash: 'shell.exec',
      PowerShell: 'shell.exec',
      WebSearch: 'web.search',
      WebFetch: 'web.fetch',
      Skill: 'skill.run',
      Agent: 'agent.spawn',
      Task: 'agent.spawn',
      TodoWrite: 'plan.update',
      TaskCreate: 'plan.update',
      TaskUpdate: 'plan.update',
      TaskList: 'plan.update',
      TaskGet: 'plan.update',
      EnterPlanMode: 'plan.update',
      ExitPlanMode: 'plan.update',
      AskUserQuestion: 'ask.user',
      mcp__oars__oars_recall: 'recall.pull',
      'mcp__oars-sessions__oars_recall': 'recall.pull',
      StructuredOutput: 'other',
      ToolSearch: 'other',
      SendMessage: 'other',
      ListAgents: 'other',
      Monitor: 'other',
      TaskStop: 'other',
      TaskOutput: 'other',
      BashOutput: 'other',
      KillShell: 'other',
      ScheduleWakeup: 'other',
      Workflow: 'other',
      EnterWorktree: 'other',
      ExitWorktree: 'other',
    },
    mcp: /^mcp__(?<server>.+?)__(?<tool>.+)$/,
    toolDelimited: true,
    shells: { Bash: 'bash', PowerShell: 'powershell' },
  },
  cursor: {
    rows: {
      read_file: 'file.read',
      read_file_v2: 'file.read',
      edit_file: 'file.edit',
      edit_file_v2: 'file.edit',
      search_replace: 'file.edit',
      reapply: 'file.edit',
      write: 'file.write',
      grep_search: 'file.search',
      grep: 'file.search',
      codebase_search: 'file.search',
      file_search: 'file.search',
      glob_file_search: 'file.search',
      list_dir: 'file.search',
      list_dir_v2: 'file.search',
      run_terminal_cmd: 'shell.exec',
      web_search: 'web.search',
      web_fetch: 'web.fetch',
      mcp_oars_oars_recall: 'recall.pull',
      todo_write: 'plan.update',
      create_plan: 'plan.update',
      ask_question: 'ask.user',
      task_v2: 'agent.spawn',
      delete_file: 'other',
      read_lints: 'other',
    },
    mcp: /^mcp_(?<server>[^_]+)_(?<tool>.+)$/,
    toolDelimited: false,
    shells: {},
  },
  // Codex's own names: its adapter names a shell and a patch call in the Claude Code vocabulary for the extractor and keeps the Codex name in `native`.
  // `write_stdin` feeds a running process (it runs no command), so it is `other`, as Claude Code's `BashOutput` is; `web_search` is the adapter's name for a
  // persisted `web_search_call`.
  codex: {
    rows: {
      shell: 'shell.exec',
      shell_command: 'shell.exec',
      exec_command: 'shell.exec',
      local_shell: 'shell.exec',
      'container.exec': 'shell.exec',
      write_stdin: 'other',
      apply_patch: 'file.edit',
      read_file: 'file.read',
      web_search: 'web.search',
      update_plan: 'plan.update',
    },
    mcp: /^mcp__(?<server>.+?)__(?<tool>.+)$/,
    toolDelimited: true,
    shells: {},
  },
  // Copilot CLI's names are not listed by its event schema; these are the ones the SDK's own hook docs use (docs/hooks/*.md). A shell call and an edit are
  // also found by shape (`shellToolInfo`, `shellExecution`, `fileEdits`) or by name and arrive in the transcript as `Bash` and `Edit` with the original name
  // in `native`, which is what this table looks up; so a name this table lacks still reads as a shell call or an edit in the tool log, but its step is `other`.
  copilot: {
    rows: {
      shell: 'shell.exec',
      bash: 'shell.exec',
      powershell: 'shell.exec',
      local_shell: 'shell.exec',
      read_file: 'file.read',
      view: 'file.read',
      glob: 'file.search',
      grep: 'file.search',
      edit: 'file.edit',
      str_replace_editor: 'file.edit',
      apply_patch: 'file.edit',
      write_file: 'file.write',
      delete_file: 'other',
      task: 'agent.spawn',
      web_fetch: 'web.fetch',
    },
    mcp: /^mcp__(?<server>.+?)__(?<tool>.+)$/,
    toolDelimited: true,
    shells: { bash: 'bash', powershell: 'powershell' },
  },
  // Gemini CLI's tool names (google-gemini/gemini-cli @ 89e9d25d, packages/core/src/tools/tool-names.ts). Its adapter names the shell, edit, read, and search
  // calls in the Claude Code vocabulary for the extractor and keeps the Gemini name in `native`, which is what this table looks up. An MCP tool is
  // `mcp_<server>_<tool>`, a spelling that does not mark where the server name ends, so its tool stays out of class P.
  gemini: {
    rows: {
      read_file: 'file.read',
      read_many_files: 'file.read',
      glob: 'file.search',
      grep_search: 'file.search',
      search_file_content: 'file.search',
      list_directory: 'file.search',
      replace: 'file.edit',
      write_file: 'file.write',
      run_shell_command: 'shell.exec',
      google_web_search: 'web.search',
      web_fetch: 'web.fetch',
      activate_skill: 'skill.run',
      invoke_agent: 'agent.spawn',
      write_todos: 'plan.update',
      enter_plan_mode: 'plan.update',
      exit_plan_mode: 'plan.update',
      tracker_create_task: 'plan.update',
      tracker_update_task: 'plan.update',
      tracker_get_task: 'plan.update',
      tracker_list_tasks: 'plan.update',
      ask_user: 'ask.user',
      mcp_oars_oars_recall: 'recall.pull',
      'mcp_oars-sessions_oars_recall': 'recall.pull',
      get_internal_docs: 'other',
      update_topic: 'other',
      complete_task: 'other',
      read_mcp_resource: 'other',
      list_mcp_resources: 'other',
    },
    mcp: /^mcp_(?<server>[^_]+)_(?<tool>.+)$/,
    toolDelimited: false,
    shells: { run_shell_command: 'bash' },
  },
};

/** The MCP call a native name spells, in full, as the transcript wrote it; undefined for any other name. */
export const mcpOf = (table: ActionTable, native: string): { server: string; tool: string } | undefined => {
  const groups = table.mcp?.exec(native)?.groups;
  const server = groups?.server;
  const tool = groups?.tool;
  return server === undefined || tool === undefined ? undefined : { server, tool };
};

/**
 * What a native name becomes on a step. Rows win over the MCP pattern, so a harness can name a recall that travels over MCP. `native` is the
 * name itself only when a row lists it; an MCP name holds a server name, so `callIdentity` decides whether it is shown.
 */
export const actionOf = (table: ActionTable, native: string): { action: CanonicalAction; native: string } => {
  // `hasOwn`: a tool named `constructor` must not read the object's prototype.
  const listed = Object.hasOwn(table.rows, native) ? table.rows[native] : undefined;
  if (listed !== undefined) return { action: listed, native };
  return { action: mcpOf(table, native) === undefined ? 'other' : 'mcp.call', native: LITERAL };
};

/** The shell a native tool runs, or null when the table does not say. */
export const shellOf = (table: ActionTable, native: string): string | null => (Object.hasOwn(table.shells, native) ? (table.shells[native] ?? null) : null);
