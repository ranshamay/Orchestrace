import { useEffect, useMemo, useState } from 'react';
import { type AgentTodo, type ChatMessage } from './lib/api';
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

const LAYOUT_PREFERENCES_KEY = 'orchestrace.ui.layout.widths.v1';
const DEFAULT_SESSION_SIDEBAR_WIDTH = 256;
const DEFAULT_RIGHT_PANE_WIDTH = 420;

type LayoutPreferences = {
  sessionSidebarWidthPx: number;
  rightPaneWidthPx: number;
};

function readLayoutPreferences(): LayoutPreferences {
  if (typeof window === 'undefined') {
    return {
      sessionSidebarWidthPx: DEFAULT_SESSION_SIDEBAR_WIDTH,
      rightPaneWidthPx: DEFAULT_RIGHT_PANE_WIDTH,
    };
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_PREFERENCES_KEY);
    if (!raw) {
      return {
        sessionSidebarWidthPx: DEFAULT_SESSION_SIDEBAR_WIDTH,
        rightPaneWidthPx: DEFAULT_RIGHT_PANE_WIDTH,
      };
    }

    const parsed = JSON.parse(raw) as Partial<LayoutPreferences>;
    return {
      sessionSidebarWidthPx: Number.isFinite(parsed.sessionSidebarWidthPx)
        ? Math.max(220, Math.round(parsed.sessionSidebarWidthPx as number))
        : DEFAULT_SESSION_SIDEBAR_WIDTH,
      rightPaneWidthPx: Number.isFinite(parsed.rightPaneWidthPx)
        ? Math.max(320, Math.round(parsed.rightPaneWidthPx as number))
        : DEFAULT_RIGHT_PANE_WIDTH,
    };
  } catch {
    return {
      sessionSidebarWidthPx: DEFAULT_SESSION_SIDEBAR_WIDTH,
      rightPaneWidthPx: DEFAULT_RIGHT_PANE_WIDTH,
    };
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('graph');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<AgentTodo[]>([]);
  const [composerText, setComposerText] = useState('');
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [todoInput, setTodoInput] = useState('');
  const [copyTraceState, setCopyTraceState] = useState<{ sessionId: string; state: 'idle' | 'copied' | 'failed' }>({ sessionId: '', state: 'idle' });
  const [layoutPreferences, setLayoutPreferences] = useState<LayoutPreferences>(() => readLayoutPreferences());

  const bootstrap = useBootstrapData();
  const {
    providers, providerStatuses, workspaces, activeWorkspaceId,
    sessions, setSessions, selectedSessionId, setSelectedSessionId,
    defaultLlmControls, setDefaultLlmControls,
    workProvider, setWorkProvider, workModel, setWorkModel,
    workWorkspaceId, setWorkWorkspaceId, autoApprove, setAutoApprove,
    useWorktree, setUseWorktree, errorMessage, setErrorMessage,
    adaptiveConcurrency, setAdaptiveConcurrency,
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
    autoApprove, setAutoApprove, useWorktree, setUseWorktree,
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
    workWorkspaceId, workProvider, workModel, autoApprove, useWorktree,
    adaptiveConcurrency, batchConcurrency, batchMinConcurrency,
    setErrorMessage, setSessions, setSelectedSessionId, setChatMessages, setTodos,
    setComposerText, setComposerImages, setLlmControlsBySessionId,
  });

  const { sessionStatusSummary, failureTypeSummary } = useMemo(() => selectSidebarSummaries(sessions), [sessions]);

  useEffect(() => {
    window.localStorage.setItem('orchestrace-use-worktree', useWorktree ? 'true' : 'false');
  }, [useWorktree]);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_PREFERENCES_KEY, JSON.stringify(layoutPreferences));
  }, [layoutPreferences]);

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
    desktopWidthPx: layoutPreferences.sessionSidebarWidthPx,
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
    useWorktree,
    composerText,
    setComposerText,
    composerImages,
    setComposerImages,
    providers,
    providerStatuses,
    activeWorkspaceId,
    onSetUseWorktree: (next) => updateActiveLlmControls({ useWorktree: next }),
    rightPaneWidthPx: layoutPreferences.rightPaneWidthPx,
    onSetRightPaneWidthPx: (next) => setLayoutPreferences((current) => ({ ...current, rightPaneWidthPx: next })),
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
    useWorktree,
    adaptiveConcurrency,
    batchConcurrency,
    batchMinConcurrency,
    closeLlmControlsModal,
    onChangeWorkspace: (workspaceId) => updateActiveLlmControls({ workspaceId }),
    onChangeProvider: (provider) => updateActiveLlmControls({ provider, model: '' }),
    onChangeModel: (model) => updateActiveLlmControls({ model }),
    onChangeAutoApprove: (next) => updateActiveLlmControls({ autoApprove: next }),
    onChangeUseWorktree: (next) => updateActiveLlmControls({ useWorktree: next }),
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
      sessionSidebarWidthPx={layoutPreferences.sessionSidebarWidthPx}
      onSetSessionSidebarWidthPx={(next) => setLayoutPreferences((current) => ({ ...current, sessionSidebarWidthPx: next }))}
    />
  );
}