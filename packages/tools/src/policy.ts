import type { AgentToolPermissions, AgentToolsetOptions } from './types.js';

export function resolveAgentToolPermissions(options: AgentToolsetOptions): AgentToolPermissions {
  const phase = options.phase ?? 'implementation';
  const taskType = options.taskType ?? 'custom';

  const defaults = getDefaultPermissions(phase, taskType);
  const overrides = options.permissions ?? {};

  return {
    ...defaults,
    ...overrides,
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
        'search_files',
        'git_diff',
        'git_status',
        'todo_get',
        'todo_set',
        'todo_add',
        'todo_update',
        'agent_graph_get',
        'agent_graph_set',
        'subagent_list',
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
        'search_files',
        'git_diff',
        'git_status',
        'todo_get',
        'todo_set',
        'todo_add',
        'todo_update',
        'agent_graph_get',
        'agent_graph_set',
        'subagent_list',
      ],
    };
  }

  return {
    allowWriteTools: true,
    allowRunCommand: true,
    toolAllowlist: [
      'list_directory',
      'read_file',
      'search_files',
      'git_diff',
      'git_status',
      'write_file',
      'edit_file',
      'run_command',
      'todo_get',
      'todo_set',
      'todo_add',
      'todo_update',
      'agent_graph_get',
      'agent_graph_set',
      'subagent_list',
      'subagent_spawn',
    ],
  };
}