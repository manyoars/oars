// The canonical action of a tool call (recall spec Section 2.2). Every harness names its tools differently, so one table per adapter
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
  // VS Code Copilot Chat's tools (microsoft/vscode @ f92b8f3, extensions/copilot/src/extension/tools/common/toolNames.ts): a tool call's `toolId` is the bare name or the
  // contributed `copilot_` one, so both spellings are rows. The adapter names a terminal call `Bash`, an edit `Edit`, and a file creation `Write`, and keeps the toolId in `native`.
  'vscode-copilot': {
    rows: {
      run_in_terminal: 'shell.exec',
      create_and_run_task: 'shell.exec',
      run_task: 'shell.exec',
      read_file: 'file.read',
      copilot_readFile: 'file.read',
      list_dir: 'file.search',
      copilot_listDirectory: 'file.search',
      file_search: 'file.search',
      copilot_findFiles: 'file.search',
      grep_search: 'file.search',
      copilot_findTextInFiles: 'file.search',
      semantic_search: 'file.search',
      copilot_searchCodebase: 'file.search',
      search_workspace_symbols: 'file.search',
      copilot_searchWorkspaceSymbols: 'file.search',
      test_search: 'file.search',
      copilot_findTestFiles: 'file.search',
      apply_patch: 'file.edit',
      copilot_applyPatch: 'file.edit',
      replace_string_in_file: 'file.edit',
      copilot_replaceString: 'file.edit',
      multi_replace_string_in_file: 'file.edit',
      copilot_multiReplaceString: 'file.edit',
      insert_edit_into_file: 'file.edit',
      copilot_insertEdit: 'file.edit',
      create_file: 'file.write',
      copilot_createFile: 'file.write',
      runSubagent: 'agent.spawn',
      search_subagent: 'agent.spawn',
      explore_subagent: 'agent.spawn',
      execution_subagent: 'agent.spawn',
      fetch_webpage: 'web.fetch',
      copilot_fetchWebPage: 'web.fetch',
      manage_todo_list: 'plan.update',
      // The rest of toolNames.ts, so no public name reads as an unlisted one with its name withheld. Notebook edits are edits, a directory or a new notebook is a write,
      // the tools that drive a terminal or a kernel feed a running process and run no command of their own (as `write_stdin` is `other`), and a skill is a skill.
      edit_notebook_file: 'file.edit',
      copilot_editNotebook: 'file.edit',
      create_new_jupyter_notebook: 'file.write',
      copilot_createNewJupyterNotebook: 'file.write',
      create_directory: 'file.write',
      copilot_createDirectory: 'file.write',
      read_notebook_cell_output: 'file.read',
      copilot_readNotebookCellOutput: 'file.read',
      copilot_getNotebookSummary: 'file.read',
      view_image: 'file.read',
      copilot_viewImage: 'file.read',
      read_project_structure: 'file.search',
      copilot_readProjectStructure: 'file.search',
      skill: 'skill.run',
      send_to_terminal: 'other',
      get_terminal_output: 'other',
      kill_terminal: 'other',
      terminal_selection: 'other',
      terminal_last_command: 'other',
      get_task_output: 'other',
      run_notebook_cell: 'other',
      copilot_runNotebookCell: 'other',
      runTests: 'other',
      testFailure: 'other',
      edit_files: 'other',
      copilot_editFiles: 'other',
      get_vscode_api: 'other',
      copilot_getVSCodeAPI: 'other',
      get_errors: 'other',
      copilot_getErrors: 'other',
      get_changed_files: 'other',
      copilot_getChangedFiles: 'other',
      memory: 'other',
      copilot_memory: 'other',
      resolve_memory_file_uri: 'other',
      copilot_resolveMemoryFileUri: 'other',
      github_repo: 'other',
      copilot_githubRepo: 'other',
      github_text_search: 'other',
      copilot_githubTextSearch: 'other',
      session_store_sql: 'other',
      copilot_sessionStoreSql: 'other',
      switch_agent: 'other',
      copilot_switchAgent: 'other',
      tool_search: 'other',
      vscode_get_confirmation: 'other',
      vscode_get_confirmation_with_options: 'other',
      vscode_reviewPlan: 'other',
      vscode_get_terminal_confirmation: 'other',
      vscode_askQuestions: 'other',
      open_browser_page: 'other',
      click_element: 'other',
      screenshot_page: 'other',
      navigate_page: 'other',
      read_page: 'other',
      hover_element: 'other',
      drag_element: 'other',
      type_in_page: 'other',
      handle_dialog: 'other',
      run_playwright_code: 'other',
    },
    // No pattern: VS Code's spelling of an MCP tool id has not been seen in a real file, so an MCP call reads as `other` with its name withheld until the hand run shows it.
    mcp: null,
    toolDelimited: false,
    shells: {},
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
      tracker_add_dependency: 'plan.update',
      tracker_visualize: 'plan.update',
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
  // Grok Build's own names (xai-org/grok-build @ 2bdd1d6, crates/codegen/xai-grok-tools): a tool's `title` is its name. A shell call and an edit reach the
  // transcript as `Bash` and `Edit` with the original name in `native`, which is what this table looks up. A name the table lacks keeps its own and its step
  // is `other`. An MCP call is `<server>__<tool>` in Grok Build; the reader spells it `mcp__<server>__<tool>`.
  grok: {
    rows: {
      run_terminal_cmd: 'shell.exec',
      run_terminal_command: 'shell.exec',
      bash: 'shell.exec',
      search_replace: 'file.edit',
      apply_patch: 'file.edit',
      edit: 'file.edit',
      hashline_edit: 'file.edit',
      write: 'file.write',
      read_file: 'file.read',
      read: 'file.read',
      hashline_read: 'file.read',
      list_dir: 'file.search',
      grep: 'file.search',
      grep_files: 'file.search',
      glob: 'file.search',
      hashline_grep: 'file.search',
      web_search: 'web.search',
      // The backend-hosted X search, named from its `variant` by the grok reader (acp_session_impl/tool_dispatch.rs:94-105).
      x_search: 'web.search',
      web_fetch: 'web.fetch',
      ask_user_question: 'ask.user',
      enter_plan_mode: 'plan.update',
      exit_plan_mode: 'plan.update',
      task: 'agent.spawn',
      // The spawn tool also arrives under these wire names (grok_build/task/mod.rs:193-196).
      Task: 'agent.spawn',
      spawn_subagent: 'agent.spawn',
      todo_write: 'plan.update',
      todowrite: 'plan.update',
      skill: 'skill.run',
    },
    mcp: /^mcp__(?<server>.+?)__(?<tool>.+)$/,
    toolDelimited: true,
    shells: { bash: 'bash', run_terminal_cmd: 'bash', run_terminal_command: 'bash' },
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
