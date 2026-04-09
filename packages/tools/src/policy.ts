import type { AgentToolPermissions, AgentToolsetOptions } from './types.js';

export const DEFAULT_AGENT_TOOL_POLICY_VERSION = 'agent-tool-policy-v1';

export function resolveAgentToolPermissions(options: AgentToolsetOptions): AgentToolPermissions {
  const phase = options.phase ?? 'implementation';
  const taskType = options.taskType ?? 'custom';

  const defaults = getDefaultPermissions(phase, taskType);
  const overrides = options.permissions ?? {};

    return {
    ...defaults,
    ...overrides,
    runCommandAllowExecutables: overrides.runCommandAllowExecutables ?? defaults.runCommandAllowExecutables,
    runCommandAllowPrefixes: overrides.runCommandAllowPrefixes ?? defaults.runCommandAllowPrefixes,
    toolAllowlist: overrides.toolAllowlist ?? defaults.toolAllowlist,
    toolBlocklist: overrides.toolBlocklist ?? defaults.toolBlocklist,
  };
}


function getDefaultPermissions(phase: string, taskType: string): AgentToolPermissions {
  if (phase === 'planning' || phase === 'chat') {
    return {
      allowWriteTools: false,
      allowRunCommand: false,
      toolAllowlist: [
        'list_directory',
        'read_file',
        'read_files',
        'search_files',
        'git_diff',
        'git_status',
        'url_fetch',
        'todo_get',
                'todo_set',
        'todo_replan',
        'todo_add',
        'todo_update',

        'mode_get',
        'mode_set',
        'agent_graph_get',
        'agent_graph_set',
        'subagent_list',
        'subagent_spawn',
        'subagent_spawn_batch',
      ],
    };
  }

  if (taskType === 'review' || taskType === 'plan') {
    return {
      allowWriteTools: false,
      allowRunCommand: false,
      toolAllowlist: [
        'list_directory',
        'read_file',
        'read_files',
        'search_files',
        'git_diff',
        'git_status',
        'url_fetch',
        'todo_get',
                'todo_set',
        'todo_replan',
        'todo_add',
        'todo_update',

        'mode_get',
        'mode_set',
        'agent_graph_get',
        'agent_graph_set',
        'subagent_list',
        'subagent_spawn',
        'subagent_spawn_batch',
      ],
    };
  }

  return {
    allowWriteTools: true,
    allowRunCommand: true,
    toolAllowlist: [
      'list_directory',
      'read_file',
      'read_files',
      'search_files',
      'git_diff',
      'git_status',
      'write_file',
      'write_files',
      'edit_file',
      'edit_files',
      'run_command',
      'run_command_batch',
      'playwright_run',
      'github_api',
      'url_fetch',
      'todo_get',
            'todo_set',
      'todo_replan',
      'todo_add',
      'todo_update',

      'mode_get',
      'mode_set',
      'agent_graph_get',
      'agent_graph_set',
      'subagent_list',
      'subagent_spawn',
      'subagent_spawn_batch',
    ],
  };
}