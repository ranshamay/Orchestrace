export type ToolIconName =
  | 'fileText'
  | 'penLine'
  | 'folderOpen'
  | 'search'
  | 'terminal'
  | 'bot'
  | 'listChecks'
  | 'network'
  | 'share'
  | 'wrench';

const iconMap: Record<string, ToolIconName> = {
  read_file: 'fileText',
  write_file: 'penLine',
  patch_file: 'penLine',
  list_directory: 'folderOpen',
  search_files: 'search',
  grep: 'search',
  run_command: 'terminal',
  playwright_run: 'terminal',
  subagent_spawn: 'bot',
  subagent_spawn_batch: 'bot',
  subagent_worker: 'bot',
  agent_graph_set: 'network',
};

const prefixMap: Array<[string, ToolIconName]> = [
  ['todo_', 'listChecks'],
  ['context_share_', 'share'],
];

export function getToolIconName(toolName: string): ToolIconName {
  const direct = iconMap[toolName];
  if (direct) return direct;
  for (const [prefix, iconName] of prefixMap) {
    if (toolName.startsWith(prefix)) return iconName;
  }
  return 'wrench';
}

export function getToolDisplayName(toolName: string): string {
  if (toolName === 'subagent_worker') return 'sub-agent';
  if (toolName === 'subagent_spawn') return 'sub-agent';
  if (toolName === 'subagent_spawn_batch') return 'sub-agent batch';
  return toolName;
}