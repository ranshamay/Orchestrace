type ToolsPanelProps = {
  toolsMode: '' | 'chat' | 'planning' | 'implementation';
  selectedSessionMode?: 'chat' | 'planning' | 'implementation';
  isToolsLoading: boolean;
  toolsLoadError: string;
  availableTools: Array<{ name: string; description: string }>;
};

export function ToolsPanel({ toolsMode, selectedSessionMode, isToolsLoading, toolsLoadError, availableTools }: ToolsPanelProps) {
  return (
    <div className="mb-2 rounded border border-slate-200 bg-slate-50 p-2.5 text-xs dark:border-slate-700 dark:bg-slate-950">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Available Tools</div>
        <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          mode {toolsMode || selectedSessionMode || 'unknown'}
        </span>
      </div>
      {isToolsLoading && <div className="text-[11px] text-slate-500 dark:text-slate-400">Loading tools...</div>}
      {!isToolsLoading && toolsLoadError && <div className="text-[11px] text-red-600 dark:text-red-300">{toolsLoadError}</div>}
      {!isToolsLoading && !toolsLoadError && availableTools.length === 0 && (
        <div className="text-[11px] text-slate-500 dark:text-slate-400">No tools available in this mode.</div>
      )}
      {!isToolsLoading && !toolsLoadError && availableTools.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-auto pr-1">
          {availableTools.map((tool) => (
            <div key={tool.name} className="rounded border border-slate-200 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-900">
              <div className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-100">{tool.name}</div>
              <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">{tool.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}