import type { LlmToolCall, LlmToolset } from '@orchestrace/provider';
import type { AgentToolPermissions, AgentToolPhase, AgentToolsetOptions, RegisteredAgentTool } from './types.js';
import { createFilesystemTools } from './fs-tools.js';
import { createCommandTools } from './command-tools.js';
import { createCoordinationTools } from './coordination-tools.js';
import { createSharedContextTools } from './shared-context-tools.js';
import { DEFAULT_AGENT_TOOL_POLICY_VERSION, resolveAgentToolPermissions } from './policy.js';

export type {
  AgentModeController,
  AgentToolPhase,
  AgentToolPermissions,
  AgentToolsetOptions,
  SubAgentContextPacket,
  SubAgentEvidenceItem,
  SubAgentRequest,
  SubAgentResult,
} from './types.js';
export type { SessionFileReadCache, FileReadCacheEntry } from './file-read-cache.js';
export { DEFAULT_AGENT_TOOL_POLICY_VERSION } from './policy.js';

export interface AgentToolDescriptor {
  name: string;
  description: string;
}

export function createAgentToolset(options: AgentToolsetOptions): LlmToolset {
  const defaultPhase = options.phase ?? 'implementation';
  const activePhase = options.modeController?.getMode() ?? defaultPhase;
  const permissions = resolveAgentToolPermissions({
    ...options,
    phase: activePhase,
  });
  const implementationPermissions = resolveAgentToolPermissions({
    ...options,
    phase: 'implementation',
  });
  const dynamicModeEnabled = Boolean(options.modeController);
  const includeWriteTools = dynamicModeEnabled ? true : permissions.allowWriteTools;
  const includeRunCommandTool = dynamicModeEnabled ? true : permissions.allowRunCommand;
  const includeSubAgentTool = Boolean(options.runSubAgent);

  const allTools = [
    ...createFilesystemTools({
      ...options,
      includeWriteTools,
    }),
    ...createCommandTools({
      ...options,
      includeRunCommandTool,
      runCommandAllowPrefixes: options.permissions?.runCommandAllowPrefixes
        ?? implementationPermissions.runCommandAllowPrefixes
        ?? permissions.runCommandAllowPrefixes,
    }),
    ...createCoordinationTools({
      ...options,
      includeSubAgentTool,
    }),
    ...(options.sharedContextStore
      ? createSharedContextTools({
          store: options.sharedContextStore,
          graphId: options.graphId,
          agentId: options.agentId ?? options.taskId ?? 'agent',
        })
      : []),
  ];

  const registeredTools = allTools.filter((entry) => {
    if (dynamicModeEnabled) {
      const availableModes = options.modeController?.availableModes ?? ['chat', 'planning', 'implementation'];
      return availableModes.some((mode) => {
        const modePermissions = resolveAgentToolPermissions({
          ...options,
          phase: mode,
        });
        return isToolAllowed(entry.tool.name, modePermissions);
      });
    }

    return isToolAllowed(entry.tool.name, permissions);
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
    executeTool: (call, signal) => executeToolCall(byName, call, options, signal),
  };
}

export function listAgentTools(options: AgentToolsetOptions): AgentToolDescriptor[] {
  const activeMode = resolveActiveMode(options);
  const activePermissions = resolveAgentToolPermissions({
    ...options,
    phase: activeMode,
  });

  return createAgentToolset(options).tools
    .filter((tool) => isToolAllowed(tool.name, activePermissions))
    .map((tool) => ({ name: tool.name, description: tool.description }));
}

function isToolAllowed(toolName: string, permissions: AgentToolPermissions): boolean {
  if (permissions.toolAllowlist && !permissions.toolAllowlist.includes(toolName)) {
    return false;
  }

  if (permissions.toolBlocklist && permissions.toolBlocklist.includes(toolName)) {
    return false;
  }

  if (
    (toolName === 'write_file'
      || toolName === 'write_files'
      || toolName === 'edit_file'
      || toolName === 'edit_files')
    && !permissions.allowWriteTools
  ) {
    return false;
  }

  if ((toolName === 'run_command' || toolName === 'run_command_batch' || toolName === 'playwright_run') && !permissions.allowRunCommand) {
    return false;
  }

  return true;
}

function resolveActiveMode(options: AgentToolsetOptions): AgentToolPhase {
  return options.modeController?.getMode() ?? options.phase ?? 'implementation';
}

async function executeToolCall(
  byName: Map<string, RegisteredAgentTool>,
  call: LlmToolCall,
  options: AgentToolsetOptions,
  signal?: AbortSignal,
) {
  const activeMode = resolveActiveMode(options);
  const activePermissions = resolveAgentToolPermissions({
    ...options,
    phase: activeMode,
  });
  if (!isToolAllowed(call.name, activePermissions)) {
    return {
      content: `Tool ${call.name} is not allowed while mode is ${activeMode}. Use mode_set to switch modes first.`,
      isError: true,
    };
  }

  const tool = byName.get(call.name);
  if (!tool) {
    return {
      content: `Unknown tool: ${call.name}`,
      isError: true,
    };
  }

  return tool.execute(call.arguments, signal);
}