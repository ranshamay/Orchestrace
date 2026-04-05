import {
  FileText,
  PenLine,
  FolderOpen,
  Search,
  Terminal,
  Bot,
  ListChecks,
  Network,
  Share2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  read_file: FileText,
  write_file: PenLine,
  patch_file: PenLine,
  list_directory: FolderOpen,
  search_files: Search,
  grep: Search,
  run_command: Terminal,
  playwright_run: Terminal,
  subagent_spawn: Bot,
  subagent_spawn_batch: Bot,
  subagent_worker: Bot,
  agent_graph_set: Network,
};

const prefixMap: Array<[string, LucideIcon]> = [
  ['todo_', ListChecks],
  ['context_share_', Share2],
];

export function getToolIcon(toolName: string): LucideIcon {
  const direct = iconMap[toolName];
  if (direct) return direct;
  for (const [prefix, icon] of prefixMap) {
    if (toolName.startsWith(prefix)) return icon;
  }
  return Wrench;
}

export function getToolDisplayName(toolName: string): string {
  if (toolName === 'subagent_worker') return 'sub-agent';
  if (toolName === 'subagent_spawn') return 'sub-agent';
  if (toolName === 'subagent_spawn_batch') return 'sub-agent batch';
  return toolName;
}
