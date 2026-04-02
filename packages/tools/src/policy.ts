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
  if (phase === 'planning') {
    return {
      allowWriteTools: false,
      allowRunCommand: false,
    };
  }

  if (phase === 'chat') {
    return {
      allowWriteTools: false,
      allowRunCommand: false,
    };
  }

  if (taskType === 'review' || taskType === 'plan') {
    return {
      allowWriteTools: false,
      allowRunCommand: false,
    };
  }

  return {
    allowWriteTools: true,
    allowRunCommand: true,
  };
}