import { useEffect, useMemo, useState } from 'react';
import { type AgentTodo, type ChatMessage, updateUiPreferences } from './lib/api';
import type { ComposerImageAttachment, Tab } from './app/types';
import { buildTimelineItems } from './app/utils/timelineItems';
import { useBootstrapData } from './app/hooks/useBootstrapData';
import { useProviderModels } from './app/hooks/useProviderModels';
import { useSessionPolling } from './app/hooks/useSessionPolling';
import { useRunUrlSync } from './app/hooks/useRunUrlSync';
import { useTimelineFollow } from './app/hooks/useTimelineFollow';
import { useToolsPanel } from './app/hooks/useToolsPanel';
import { useLlmControls } from './app/hooks/useLlmControls';
import { useSessionActions } from './app/hooks/useSessionActions';
import { useThemePreference } from './app/hooks/useThemePreference';
import { useSessionSelectionController } from './app/hooks/useSessionSelectionController';
import { useLlmControlsModalState } from './app/hooks/useLlmControlsModalState';
import { selectCurrentSession, selectSessionViewState, selectSidebarSummaries } from './app/selectors/sessionViewSelectors';
import { buildSessionSidebarProps } from './app/shell/props/buildSessionSidebarProps';
import { buildMainContentProps } from './app/shell/props/buildMainContentProps';
import { buildLlmModalProps } from './app/shell/props/buildLlmModalProps';
import { AppShell } from './app/shell/AppShell';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('graph');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [composerText, setComposerText] = useState('');
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [todoInput, setTodoInput] = useState('');
  const [copyTraceState, setCopyTraceState] = useState<{ sessionId: string; state: 'idle' | 'copied' | 'failed' }>({ sessionId: '', state: 'idle' });

  const bootstrap = useBootstrapData();
  const {
    providers, providerStatuses, workspaces, activeWorkspaceId,
    sessions, setSessions, selectedSessionId, setSelectedSessionId,
    defaultLlmControls, setDefaultLlmControls,
    workProvider, setWorkProvider, workModel, setWorkModel,
    workWorkspaceId, setWorkWorkspaceId, autoApprove, setAutoApprove,
    errorMessage, setErrorMessage,
    adaptiveConcurrency, setAdaptiveConcurrency,
    bootstrapComplete,
    batchConcurrency, setBatchConcurrency,
    batchMinConcurrency, setBatchMinConcurrency,
  } = bootstrap;

  const { theme, setTheme, isDark } = useThemePreference();
  const { setSessionSelection } = useSessionSelectionController({ selectedSessionId, sessions, setSelectedSessionId });
  const { isLlmControlsModalOpen, openLlmControlsModal, closeLlmControlsModal } = useLlmControlsModalState();

  useSessionPolling({ selectedSessionId, setSelectedSessionId: setSessionSelection, setSessions, setChatMessages, setTodos });
  useRunUrlSync(selectedSessionId, setSessionSelection);

  const selectedSession = useMemo(() => selectCurrentSession(sessions, selectedSessionId), [sessions, selectedSessionId]);
  const { selectedLlmStatus, selectedFailureType, selectedSessionRunning, composerMode } = useMemo(
    () => selectSessionViewState(selectedSession),
    [selectedSession],
  );

  const { setLlmControlsBySessionId, updateActiveLlmControls } = useLlmControls({
    selectedSessionId, selectedSession, defaultLlmControls, setDefaultLlmControls,
    workProvider, setWorkProvider, workModel, setWorkModel, workWorkspaceId, setWorkWorkspaceId,
    autoApprove, setAutoApprove,
    adaptiveConcurrency, setAdaptiveConcurrency,
    batchConcurrency, setBatchConcurrency,
    batchMinConcurrency, setBatchMinConcurrency,
  });
  const { currentModels } = useProviderModels(workProvider, workModel, setWorkModel);

  const timelineItems = useMemo(() => buildTimelineItems(selectedSession, chatMessages), [chatMessages, selectedSession]);
  const latestTimelineKey = timelineItems[timelineItems.length - 1]?.key ?? '';
  const timelineFollow = useTimelineFollow(latestTimelineKey, selectedSessionId);
  const toolsPanel = useToolsPanel(showToolsPanel, selectedSessionId, composerMode, selectedSession?.mode);

  const actions = useSessionActions({
    selectedSessionId, selectedSession, sessions, chatMessages, todos, composerText, composerImages,
    workWorkspaceId, workProvider, workModel, autoApprove,
    adaptiveConcurrency, batchConcurrency, batchMinConcurrency,
    setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos,
    setComposerText, setComposerImages, setLlmControlsBySessionId,
  });

  const { sessionStatusSummary, failureTypeSummary } = useMemo(() => selectSidebarSummaries(sessions), [sessions]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    void updateUiPreferences({
      adaptiveConcurrency,
      batchConcurrency,
      batchMinConcurrency,
    }).catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }, [adaptiveConcurrency, batchConcurrency, batchMinConcurrency, bootstrapComplete, setErrorMessage]);

  const sessionSidebarProps = buildSessionSidebarProps({
    activeTab,
    setActiveTab,
    theme,
    setTheme,
    sessions,
    selectedSessionId,
    setSessionSelection,
    setCopyTraceState,
    actions,
    copyTraceState,
    sessionStatusSummary,
    failureTypeSummary,
  });

  const mainContentProps = buildMainContentProps({
    activeTab,
    selectedSessionId,
    selectedSession,
    selectedSessionRunning,
    selectedFailureType: selectedFailureType ?? null,
    selectedLlmStatus,
    isDark,
    todos,
    todoInput,
    setTodoInput,
    actions,
    openLlmControlsModal,
    showToolsPanel,
    setShowToolsPanel,
    toolsPanel,
    timelineFollow: {
      timelineContainerRef: timelineFollow.timelineContainerRef,
      followTimelineTail: timelineFollow.followTimelineTail,
      jumpToLatest: timelineFollow.jumpToLatest,
      onTimelineScroll: timelineFollow.handleTimelineScroll,
    },
    timelineItems,
    composerMode,
    workspaces,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    composerText,
    setComposerText,
    composerImages,
    setComposerImages,
    providers,
    providerStatuses,
    activeWorkspaceId,
  });

  const llmModalProps = buildLlmModalProps({
    isOpen: isLlmControlsModalOpen,
    providers,
    workspaces,
    currentModels,
    workWorkspaceId,
    workProvider,
    workModel,
    autoApprove,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    closeLlmControlsModal,
    onChangeWorkspace: (workspaceId) => updateActiveLlmControls({ workspaceId }),
    onChangeProvider: (provider) => updateActiveLlmControls({ provider, model: '' }),
    onChangeModel: (model) => updateActiveLlmControls({ model }),
    onChangeAutoApprove: (next) => updateActiveLlmControls({ autoApprove: next }),
    onChangeAdaptiveConcurrency: (next) => updateActiveLlmControls({ adaptiveConcurrency: next }),
    onChangeBatchConcurrency: (next) => updateActiveLlmControls({ batchConcurrency: next }),
    onChangeBatchMinConcurrency: (next) => updateActiveLlmControls({ batchMinConcurrency: next }),
  });

  return (
    <AppShell
      sessionSidebarProps={sessionSidebarProps}
      mainContentProps={mainContentProps}
      llmModalProps={llmModalProps}
      errorMessage={errorMessage}
    />
  );
}