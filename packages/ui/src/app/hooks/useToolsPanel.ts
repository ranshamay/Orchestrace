import { useEffect, useState } from 'react';
import { fetchWorkTools } from '../../lib/api';
import type { ComposerMode } from '../types';

export function useToolsPanel(showToolsPanel: boolean, selectedSessionId: string, composerMode: ComposerMode, selectedSessionMode?: ComposerMode) {
  const [availableTools, setAvailableTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolsMode, setToolsMode] = useState<'chat' | 'planning' | 'implementation' | ''>('');
  const [isToolsLoading, setIsToolsLoading] = useState(false);
  const [toolsLoadError, setToolsLoadError] = useState('');

  useEffect(() => {
    if (!showToolsPanel) {
      return;
    }

    if (!selectedSessionId) {
      setAvailableTools([]);
      setToolsMode('');
      setToolsLoadError('Select a run to inspect tools.');
      return;
    }

    let cancelled = false;
    setIsToolsLoading(true);
    setToolsLoadError('');

    const loadTools = async () => {
      try {
        const requestedMode: 'chat' | 'planning' | 'implementation' | undefined =
          selectedSessionMode && selectedSessionMode !== 'run'
            ? (selectedSessionMode === 'testing' ? 'implementation' : selectedSessionMode)
            : (composerMode !== 'run' ? (composerMode === 'testing' ? 'implementation' : composerMode) : undefined);
        const toolsState = await fetchWorkTools(selectedSessionId, requestedMode);
        if (cancelled) {
          return;
        }

        setToolsMode(toolsState.mode);
        setAvailableTools(toolsState.tools);
      } catch (error) {
        if (cancelled) {
          return;
        }

        setToolsLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setIsToolsLoading(false);
        }
      }
    };

    void loadTools();

    return () => {
      cancelled = true;
    };
  }, [composerMode, selectedSessionId, selectedSessionMode, showToolsPanel]);

  return {
    availableTools,
    toolsMode,
    isToolsLoading,
    toolsLoadError,
  };
}