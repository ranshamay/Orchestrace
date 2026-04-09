import { useCallback, useEffect, useState } from 'react';
import type { WorkSession } from '../../lib/api';
import type { SessionLlmControls } from '../types';

type Params = {
  selectedSessionId: string;
  selectedSession?: WorkSession;
  defaultLlmControls: SessionLlmControls;
  setDefaultLlmControls: (next: SessionLlmControls) => void;
  workPlanningProvider: string;
  setWorkPlanningProvider: (value: string) => void;
  workPlanningModel: string;
  setWorkPlanningModel: (value: string) => void;
  workProvider: string;
  setWorkProvider: (value: string) => void;
  workModel: string;
  setWorkModel: (value: string) => void;
  workWorkspaceId: string;
  setWorkWorkspaceId: (value: string) => void;
  planningNoToolGuardMode: 'enforce' | 'warn';
  setPlanningNoToolGuardMode: (value: 'enforce' | 'warn') => void;
  autoApprove: boolean;
  setAutoApprove: (value: boolean) => void;
  adaptiveConcurrency: boolean;
  setAdaptiveConcurrency: (value: boolean) => void;
  batchConcurrency: number;
  setBatchConcurrency: (value: number) => void;
  batchMinConcurrency: number;
  setBatchMinConcurrency: (value: number) => void;
};

export function useLlmControls(params: Params) {
  const {
    selectedSessionId,
    selectedSession,
    defaultLlmControls,
    setDefaultLlmControls,
    workPlanningProvider,
    setWorkPlanningProvider,
    workPlanningModel,
    setWorkPlanningModel,
    workProvider,
    setWorkProvider,
    workModel,
    setWorkModel,
    workWorkspaceId,
    setWorkWorkspaceId,
    planningNoToolGuardMode,
    setPlanningNoToolGuardMode,
    autoApprove,
    setAutoApprove,
    adaptiveConcurrency,
    setAdaptiveConcurrency,
    batchConcurrency,
    setBatchConcurrency,
    batchMinConcurrency,
    setBatchMinConcurrency,
  } = params;

  const [llmControlsBySessionId, setLlmControlsBySessionId] = useState<Record<string, SessionLlmControls>>({});

  const applyWorkingControls = useCallback((controls: SessionLlmControls) => {
    if (workPlanningProvider !== controls.planningProvider) setWorkPlanningProvider(controls.planningProvider);
    if (workPlanningModel !== controls.planningModel) setWorkPlanningModel(controls.planningModel);
    if (workProvider !== controls.implementationProvider) setWorkProvider(controls.implementationProvider);
    if (workModel !== controls.implementationModel) setWorkModel(controls.implementationModel);
    if (workWorkspaceId !== controls.workspaceId) setWorkWorkspaceId(controls.workspaceId);
    if (planningNoToolGuardMode !== controls.planningNoToolGuardMode) {
      setPlanningNoToolGuardMode(controls.planningNoToolGuardMode);
    }
    if (autoApprove !== controls.autoApprove) setAutoApprove(controls.autoApprove);
    if (adaptiveConcurrency !== controls.adaptiveConcurrency) setAdaptiveConcurrency(controls.adaptiveConcurrency);
    if (batchConcurrency !== controls.batchConcurrency) setBatchConcurrency(controls.batchConcurrency);
    if (batchMinConcurrency !== controls.batchMinConcurrency) setBatchMinConcurrency(controls.batchMinConcurrency);
  }, [
    adaptiveConcurrency,
    autoApprove,
    batchConcurrency,
    batchMinConcurrency,
    setAdaptiveConcurrency,
    setAutoApprove,
    setPlanningNoToolGuardMode,
    setBatchConcurrency,
    setBatchMinConcurrency,
    setWorkPlanningModel,
    setWorkPlanningProvider,
    setWorkModel,
    setWorkProvider,
    setWorkWorkspaceId,
    planningNoToolGuardMode,
    workPlanningModel,
    workPlanningProvider,
    workModel,
    workProvider,
    workWorkspaceId,
  ]);

  const updateActiveLlmControls = useCallback((patch: Partial<SessionLlmControls>) => {
    const next: SessionLlmControls = {
      planningProvider: patch.planningProvider ?? workPlanningProvider,
      planningModel: patch.planningModel ?? workPlanningModel,
      implementationProvider: patch.implementationProvider ?? workProvider,
      implementationModel: patch.implementationModel ?? workModel,
      planningNoToolGuardMode: patch.planningNoToolGuardMode ?? planningNoToolGuardMode,
      workspaceId: patch.workspaceId ?? workWorkspaceId,
      autoApprove: patch.autoApprove ?? autoApprove,
      adaptiveConcurrency: patch.adaptiveConcurrency ?? adaptiveConcurrency,
      batchConcurrency: patch.batchConcurrency ?? batchConcurrency,
      batchMinConcurrency: patch.batchMinConcurrency ?? batchMinConcurrency,
    };

    applyWorkingControls(next);
    if (selectedSessionId) {
      setLlmControlsBySessionId((current) => ({ ...current, [selectedSessionId]: next }));
      return;
    }
    setDefaultLlmControls(next);
  }, [
    adaptiveConcurrency,
    applyWorkingControls,
    autoApprove,
    batchConcurrency,
    batchMinConcurrency,
    selectedSessionId,
    setDefaultLlmControls,
    planningNoToolGuardMode,
    workPlanningModel,
    workPlanningProvider,
    workModel,
    workProvider,
    workWorkspaceId,
  ]);

  useEffect(() => {
    if (!selectedSessionId) {
      const draftControls: SessionLlmControls = {
        planningProvider: defaultLlmControls.planningProvider || workPlanningProvider,
        planningModel: defaultLlmControls.planningModel || workPlanningModel,
        implementationProvider: defaultLlmControls.implementationProvider || workProvider,
        implementationModel: defaultLlmControls.implementationModel || workModel,
        planningNoToolGuardMode: defaultLlmControls.planningNoToolGuardMode,
        workspaceId: defaultLlmControls.workspaceId || workWorkspaceId,
        autoApprove: defaultLlmControls.autoApprove,
        adaptiveConcurrency: defaultLlmControls.adaptiveConcurrency,
        batchConcurrency: defaultLlmControls.batchConcurrency,
        batchMinConcurrency: defaultLlmControls.batchMinConcurrency,
      };
      applyWorkingControls(draftControls);
      return;
    }

    const existing = llmControlsBySessionId[selectedSessionId];
    if (existing) {
      applyWorkingControls(existing);
      return;
    }

    if (!selectedSession) return;

    const sessionControls: SessionLlmControls = {
      planningProvider: selectedSession.planningProvider
        || defaultLlmControls.planningProvider
        || selectedSession.provider,
      planningModel: selectedSession.planningModel
        || defaultLlmControls.planningModel
        || selectedSession.model,
      implementationProvider: selectedSession.implementationProvider
        || defaultLlmControls.implementationProvider
        || selectedSession.provider,
      implementationModel: selectedSession.implementationModel
        || defaultLlmControls.implementationModel
        || selectedSession.model,
      planningNoToolGuardMode: selectedSession.planningNoToolGuardMode ?? defaultLlmControls.planningNoToolGuardMode,
      workspaceId: selectedSession.workspaceId || defaultLlmControls.workspaceId,
      autoApprove: selectedSession.autoApprove,
      adaptiveConcurrency: selectedSession.adaptiveConcurrency ?? defaultLlmControls.adaptiveConcurrency,
      batchConcurrency: selectedSession.batchConcurrency ?? defaultLlmControls.batchConcurrency,
      batchMinConcurrency: selectedSession.batchMinConcurrency ?? defaultLlmControls.batchMinConcurrency,
    };

    applyWorkingControls(sessionControls);
  }, [applyWorkingControls, defaultLlmControls, llmControlsBySessionId, selectedSession, selectedSessionId]);

  return {
    llmControlsBySessionId,
    setLlmControlsBySessionId,
    updateActiveLlmControls,
  };
}