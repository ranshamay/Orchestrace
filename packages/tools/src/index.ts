import type { LlmToolCall, LlmToolset } from '@orchestrace/provider';
import type { AgentToolsetOptions, RegisteredAgentTool } from './types.js';
import { createFilesystemTools } from './fs-tools.js';
import { createCommandTools } from './command-tools.js';
import { resolveAgentToolPermissions } from './policy.js';

export type { AgentToolPhase, AgentToolPermissions, AgentToolsetOptions } from './types.js';

export function createAgentToolset(options: AgentToolsetOptions): LlmToolset {
  const permissions = resolveAgentToolPermissions(options);

  const allTools = [
    ...createFilesystemTools({
      ...options,
      includeWriteTools: permissions.allowWriteTools,
    }),
    ...createCommandTools({
      ...options,
      includeRunCommandTool: permissions.allowRunCommand,
      runCommandAllowPrefixes: permissions.runCommandAllowPrefixes,
    }),
  ];

  const registeredTools = allTools.filter((entry) => {
    if (permissions.toolAllowlist && !permissions.toolAllowlist.includes(entry.tool.name)) {
      return false;
    }

    if (permissions.toolBlocklist && permissions.toolBlocklist.includes(entry.tool.name)) {
      return false;
    }

    return true;
  });

  const byName = new Map<string, RegisteredAgentTool>();
  for (const tool of registeredTools) {
    byName.set(tool.tool.name, tool);
  }

  return {
    tools: registeredTools.map((entry) => ({
      name: entry.tool.name,
      description: entry.tool.description,
      parameters: entry.tool.parameters,
    })),
    executeTool: (call, signal) => executeToolCall(byName, call, signal),
  };
}

async function executeToolCall(
  byName: Map<string, RegisteredAgentTool>,
  call: LlmToolCall,
  signal?: AbortSignal,
) {
  const tool = byName.get(call.name);
  if (!tool) {
    return {
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  return tool.execute(call.arguments, signal);
}