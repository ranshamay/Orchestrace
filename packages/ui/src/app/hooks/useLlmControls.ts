import { useCallback, useEffect, useState } from 'react';
import type { WorkSession } from '../../lib/api';
import type { SessionLlmControls } from '../types';

type Params = {
  selectedSessionId: string;
  selectedSession?: WorkSession;
  defaultLlmControls: SessionLlmControls;
  setDefaultLlmControls: (next: SessionLlmControls) => void;
  workProvider: string;
  setWorkProvider: (value: string) => void;
  workModel: string;
  setWorkModel: (value: string) => void;
  workWorkspaceId: string;
  setWorkWorkspaceId: (value: string) => void;
  autoApprove: boolean;
  setAutoApprove: (value: boolean) => void;
  useWorktree: boolean;
  setUseWorktree: (value: boolean) => void;
};

export function useLlmControls(params: Params) {
  const {
    selectedSessionId,
    selectedSession,
    defaultLlmControls,
    setDefaultLlmControls,
    workProvider,
    setWorkProvider,
    workModel,
    setWorkModel,
    workWorkspaceId,
    setWorkWorkspaceId,
    autoApprove,
    setAutoApprove,
    useWorktree,
    setUseWorktree,
  } = params;

  const [llmControlsBySessionId, setLlmControlsBySessionId] = useState<Record<string, SessionLlmControls>>({});

  const applyWorkingControls = useCallback((controls: SessionLlmControls) => {
    if (workProvider !== controls.provider) setWorkProvider(controls.provider);
    if (workModel !== controls.model) setWorkModel(controls.model);
    if (workWorkspaceId !== controls.workspaceId) setWorkWorkspaceId(controls.workspaceId);
    if (autoApprove !== controls.autoApprove) setAutoApprove(controls.autoApprove);
    if (useWorktree !== controls.useWorktree) setUseWorktree(controls.useWorktree);
  }, [autoApprove, setAutoApprove, setUseWorktree, setWorkModel, setWorkProvider, setWorkWorkspaceId, useWorktree, workModel, workProvider, workWorkspaceId]);

  const updateActiveLlmControls = useCallback((patch: Partial<SessionLlmControls>) => {
    const next: SessionLlmControls = {
      provider: patch.provider ?? workProvider,
      model: patch.model ?? workModel,
      workspaceId: patch.workspaceId ?? workWorkspaceId,
      autoApprove: patch.autoApprove ?? autoApprove,
      useWorktree: patch.useWorktree ?? useWorktree,
    };

    applyWorkingControls(next);
    if (selectedSessionId) {
      setLlmControlsBySessionId((current) => ({ ...current, [selectedSessionId]: next }));
      return;
    }
    setDefaultLlmControls(next);
  }, [applyWorkingControls, autoApprove, selectedSessionId, setDefaultLlmControls, useWorktree, workModel, workProvider, workWorkspaceId]);

  useEffect(() => {
    if (!selectedSessionId) {
      applyWorkingControls(defaultLlmControls);
      return;
    }

    const existing = llmControlsBySessionId[selectedSessionId];
    if (existing) {
      applyWorkingControls(existing);
      return;
    }

    if (!selectedSession) return;

    const sessionControls: SessionLlmControls = {
      provider: selectedSession.provider || defaultLlmControls.provider,
      model: selectedSession.model || defaultLlmControls.model,
      workspaceId: selectedSession.workspaceId || defaultLlmControls.workspaceId,
      autoApprove: selectedSession.autoApprove,
      useWorktree: selectedSession.useWorktree ?? defaultLlmControls.useWorktree,
    };

    applyWorkingControls(sessionControls);
  }, [applyWorkingControls, defaultLlmControls, llmControlsBySessionId, selectedSession, selectedSessionId]);

  return {
    llmControlsBySessionId,
    setLlmControlsBySessionId,
    updateActiveLlmControls,
  };
}