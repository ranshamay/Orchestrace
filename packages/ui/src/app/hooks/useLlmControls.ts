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
  deliveryStrategy: 'pr-only' | 'merge-after-ci';
  setDeliveryStrategy: (value: 'pr-only' | 'merge-after-ci') => void;
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
    deliveryStrategy,
    setDeliveryStrategy,
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
    if (deliveryStrategy !== controls.deliveryStrategy) setDeliveryStrategy(controls.deliveryStrategy);
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
    setDeliveryStrategy,
    setWorkWorkspaceId,
    deliveryStrategy,
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
      agentModels: patch.agentModels ?? defaultLlmControls.agentModels,
      deliveryStrategy: patch.deliveryStrategy ?? deliveryStrategy,
      planningNoToolGuardMode: patch.planningNoToolGuardMode ?? planningNoToolGuardMode,
      workspaceId: patch.workspaceId ?? workWorkspaceId,
      autoApprove: patch.autoApprove ?? autoApprove,
      quickStartMode: patch.quickStartMode ?? defaultLlmControls.quickStartMode,
      quickStartMaxPreDelegationToolCalls: patch.quickStartMaxPreDelegationToolCalls ?? defaultLlmControls.quickStartMaxPreDelegationToolCalls,
      adaptiveConcurrency: patch.adaptiveConcurrency ?? adaptiveConcurrency,
      batchConcurrency: patch.batchConcurrency ?? batchConcurrency,
      batchMinConcurrency: patch.batchMinConcurrency ?? batchMinConcurrency,
      enableTrivialTaskGate: patch.enableTrivialTaskGate ?? defaultLlmControls.enableTrivialTaskGate,
      trivialTaskMaxPromptLength: patch.trivialTaskMaxPromptLength ?? defaultLlmControls.trivialTaskMaxPromptLength,
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
    defaultLlmControls.agentModels,
    workPlanningModel,
    workPlanningProvider,
    workModel,
    workProvider,
    deliveryStrategy,
    workWorkspaceId,
  ]);

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
      agentModels: selectedSession.agentModels ?? defaultLlmControls.agentModels,
      deliveryStrategy: selectedSession.deliveryStrategy ?? defaultLlmControls.deliveryStrategy,
      planningNoToolGuardMode: selectedSession.planningNoToolGuardMode ?? defaultLlmControls.planningNoToolGuardMode,
      workspaceId: selectedSession.workspaceId || defaultLlmControls.workspaceId,
      autoApprove: selectedSession.autoApprove,
      quickStartMode: selectedSession.quickStartMode ?? defaultLlmControls.quickStartMode,
      quickStartMaxPreDelegationToolCalls: selectedSession.quickStartMaxPreDelegationToolCalls ?? defaultLlmControls.quickStartMaxPreDelegationToolCalls,
      adaptiveConcurrency: selectedSession.adaptiveConcurrency ?? defaultLlmControls.adaptiveConcurrency,
      batchConcurrency: selectedSession.batchConcurrency ?? defaultLlmControls.batchConcurrency,
      batchMinConcurrency: selectedSession.batchMinConcurrency ?? defaultLlmControls.batchMinConcurrency,
      enableTrivialTaskGate: selectedSession.enableTrivialTaskGate ?? defaultLlmControls.enableTrivialTaskGate,
      trivialTaskMaxPromptLength: selectedSession.trivialTaskMaxPromptLength ?? defaultLlmControls.trivialTaskMaxPromptLength,
    };

    applyWorkingControls(sessionControls);
  }, [applyWorkingControls, defaultLlmControls, llmControlsBySessionId, selectedSession, selectedSessionId]);

  return {
    llmControlsBySessionId,
    setLlmControlsBySessionId,
    updateActiveLlmControls,
  };
}