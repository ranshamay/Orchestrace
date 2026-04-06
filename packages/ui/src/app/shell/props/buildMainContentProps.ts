import type { AppMainContentProps } from '../../components/AppMainContent';

type Params = {
  activeTab: AppMainContentProps['activeTab'];
  selectedSessionId: string;
  selectedSession: AppMainContentProps['selectedSession'];
  selectedSessionRunning: boolean;
  selectedFailureType: AppMainContentProps['selectedFailureType'];
  selectedLlmStatus: AppMainContentProps['selectedLlmStatus'];
  isDark: boolean;
  todos: AppMainContentProps['todos'];
  todoInput: string;
  setTodoInput: (value: string) => void;
  actions: {
    handleAddTodo: (todoInput: string, setTodoInput: (value: string) => void) => Promise<void>;
    handleToggleTodo: AppMainContentProps['onToggleTodo'];
    hasComposerContent: boolean;
    handleComposerPaste: AppMainContentProps['onComposerPaste'];
    handleStartFromComposer: AppMainContentProps['onStartFromComposer'];
    handleSendChat: AppMainContentProps['onSendChat'];
    handleStop: AppMainContentProps['onStop'];
  };
  openLlmControlsModal: () => void;
  showToolsPanel: boolean;
  setShowToolsPanel: AppMainContentProps['setShowToolsPanel'];
  toolsPanel: Pick<AppMainContentProps, 'toolsMode' | 'availableTools' | 'isToolsLoading' | 'toolsLoadError'>;
  timelineFollow: Pick<AppMainContentProps, 'timelineContainerRef' | 'followTimelineTail' | 'jumpToLatest' | 'onTimelineScroll'>;
  timelineItems: AppMainContentProps['timelineItems'];
  composerMode: AppMainContentProps['composerMode'];
  workspaces: AppMainContentProps['workspaces'];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: AppMainContentProps['composerImages'];
  setComposerImages: (updater: AppMainContentProps['composerImages'] | ((current: AppMainContentProps['composerImages']) => AppMainContentProps['composerImages'])) => void;
  providers: AppMainContentProps['providers'];
  providerStatuses: AppMainContentProps['providerStatuses'];
  activeWorkspaceId: string;
};

export function buildMainContentProps(params: Params): AppMainContentProps {
  return {
    activeTab: params.activeTab,
    selectedSessionId: params.selectedSessionId,
    selectedSession: params.selectedSession,
    selectedSessionRunning: params.selectedSessionRunning,
    selectedFailureType: params.selectedFailureType,
    selectedLlmStatus: params.selectedLlmStatus,
    isDark: params.isDark,
    todos: params.todos,
    todoInput: params.todoInput,
    setTodoInput: params.setTodoInput,
    onAddTodo: () => params.actions.handleAddTodo(params.todoInput, params.setTodoInput),
    onToggleTodo: params.actions.handleToggleTodo,
    onOpenLlmControls: params.openLlmControlsModal,
    showToolsPanel: params.showToolsPanel,
    setShowToolsPanel: params.setShowToolsPanel,
    toolsMode: params.toolsPanel.toolsMode,
    availableTools: params.toolsPanel.availableTools,
    isToolsLoading: params.toolsPanel.isToolsLoading,
    toolsLoadError: params.toolsPanel.toolsLoadError,
    timelineContainerRef: params.timelineFollow.timelineContainerRef,
    followTimelineTail: params.timelineFollow.followTimelineTail,
    jumpToLatest: params.timelineFollow.jumpToLatest,
    onTimelineScroll: params.timelineFollow.onTimelineScroll,
    timelineItems: params.timelineItems,
    composerMode: params.composerMode,
    workspaces: params.workspaces,
    workWorkspaceId: params.workWorkspaceId,
    workProvider: params.workProvider,
    workModel: params.workModel,
    autoApprove: params.autoApprove,
    composerText: params.composerText,
    setComposerText: params.setComposerText,
    composerImages: params.composerImages,
    removeComposerAttachment: (id) => params.setComposerImages((current) => current.filter((item) => item.id !== id)),
    hasComposerContent: params.actions.hasComposerContent,
    onComposerPaste: params.actions.handleComposerPaste,
    onStartFromComposer: params.actions.handleStartFromComposer,
    onSendChat: params.actions.handleSendChat,
    onStop: params.actions.handleStop,
    providers: params.providers,
    providerStatuses: params.providerStatuses,
    activeWorkspaceId: params.activeWorkspaceId,
  };
}