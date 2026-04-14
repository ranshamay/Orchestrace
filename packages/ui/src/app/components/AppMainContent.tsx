import type { AgentModels, AgentTodo, ProviderInfo, SessionObserverState, WorkSession, Workspace } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode, FailureType, LlmSessionStatus, NodeTokenStream, TimelineItem } from '../types';
import type { ChatMessage } from '../chat-types';
import type { SettingsSaveToastState } from './overlays/SettingsSaveToast';
import { GraphTabView } from './graph/GraphTabView';
import { ChatPanel } from './chat/ChatPanel';
import { ComposerPanel } from './work/ComposerPanel';
import { LogsTabView } from './work/LogsTabView';
import { SettingsTabView } from './settings/SettingsTabView';

type LiveReasoning = {
  taskId: string;
  phase: 'planning' | 'implementation';
  text: string;
  updatedAt: string;
};

export type AppMainContentProps = {
  activeTab: 'graph' | 'settings' | 'logs';
  selectedSessionId: string;
  selectedSession?: WorkSession;
  selectedSessionRunning: boolean;
  selectedFailureType: FailureType | null;
  selectedLlmStatus: LlmSessionStatus;
  isDark: boolean;
  todos: AgentTodo[];
  todoInput: string;
  setTodoInput: (value: string) => void;
  onAddTodo: () => Promise<void>;
  onToggleTodo: (todo: AgentTodo) => Promise<void>;
  onOpenLlmControls: () => void;
  showToolsPanel: boolean;
  setShowToolsPanel: (next: boolean | ((current: boolean) => boolean)) => void;
  toolsMode: '' | 'chat' | 'planning' | 'implementation';
  availableTools: Array<{ name: string; description: string }>;
  isToolsLoading: boolean;
  toolsLoadError: string;
  timelineContainerRef: React.RefObject<HTMLDivElement | null>;
  followTimelineTail: boolean;
  jumpToLatest: () => void;
  onTimelineScroll: () => void;
  timelineItems: TimelineItem[];
  liveReasoning: LiveReasoning | null;
  chatMessages: ChatMessage[];
  chatIsStreaming: boolean;
  chatActiveMessageId: string | null;
  chatFirstTokenLatencyMs: number | null;
  chatWaitingForFirstToken: boolean;
  chatActiveToolCalls: number;
  composerMode: ComposerMode;
  workspaces: Workspace[];
  workWorkspaceId: string;
  workPlanningProvider: string;
  workPlanningModel: string;
  workProvider: string;
  workModel: string;
  planningNoToolGuardMode: 'enforce' | 'warn';
  autoApprove: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: ComposerImageAttachment[];
  removeComposerAttachment: (id: string) => void;
  hasComposerContent: boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  onSendChat: () => Promise<void>;
  onStop: () => Promise<void>;
  onApprovePlan: () => Promise<void>;
  onRejectPlan: () => Promise<void>;
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  activeWorkspaceId: string;
  defaultPlanningProvider: string;
  defaultPlanningModel: string;
  defaultImplementationProvider: string;
  defaultImplementationModel: string;
  defaultAgentModels: AgentModels;
  defaultPlanningNoToolGuardMode: 'enforce' | 'warn';
  onSetDefaultPlanningProvider: (next: string) => void;
  onSetDefaultPlanningModel: (next: string) => void;
  onSetDefaultImplementationProvider: (next: string) => void;
  onSetDefaultImplementationModel: (next: string) => void;
  onSetDefaultRouterProvider: (next: string) => void;
  onSetDefaultRouterModel: (next: string) => void;
  onSetDefaultReviewerProvider: (next: string) => void;
  onSetDefaultReviewerModel: (next: string) => void;
  onSetDefaultInvestigatorProvider: (next: string) => void;
  onSetDefaultInvestigatorModel: (next: string) => void;
  onSetDefaultPlanningNoToolGuardMode: (next: 'enforce' | 'warn') => void;
  quickStartMode: boolean;
  onSetQuickStartMode: (next: boolean) => void;
  quickStartMaxPreDelegationToolCalls: number;
  onSetQuickStartMaxPreDelegationToolCalls: (next: number) => void;
  adaptiveConcurrency: boolean;
  onSetAdaptiveConcurrency: (next: boolean) => void;
  batchConcurrency: number;
  onSetBatchConcurrency: (next: number) => void;
  batchMinConcurrency: number;
  onSetBatchMinConcurrency: (next: number) => void;
  enableTrivialTaskGate: boolean;
  onSetEnableTrivialTaskGate: (next: boolean) => void;
  trivialTaskMaxPromptLength: number;
  onSetTrivialTaskMaxPromptLength: (next: number) => void;
  observerShowFindings: boolean;
  onSetObserverShowFindings: (next: boolean) => void;
  onSettingsSaveStatus: (state: Exclude<SettingsSaveToastState, 'idle'>, message: string) => void;
  nodeTokenStreams: Record<string, NodeTokenStream>;
  observerState: SessionObserverState | null;
  copyTraceState: 'idle' | 'copied' | 'failed';
  onCopyTrace: () => void;
};

export function AppMainContent(props: AppMainContentProps) {
  if (props.activeTab === 'logs') {
    return <LogsTabView />;
  }

  if (props.activeTab === 'settings') {
    return (
      <SettingsTabView
        providers={props.providers}
        providerStatuses={props.providerStatuses}
        workspaces={props.workspaces}
        activeWorkspaceId={props.activeWorkspaceId}
        defaultPlanningProvider={props.defaultPlanningProvider}
        defaultPlanningModel={props.defaultPlanningModel}
        defaultImplementationProvider={props.defaultImplementationProvider}
        defaultImplementationModel={props.defaultImplementationModel}
        defaultAgentModels={props.defaultAgentModels}
        defaultPlanningNoToolGuardMode={props.defaultPlanningNoToolGuardMode}
        setDefaultPlanningProvider={props.onSetDefaultPlanningProvider}
        setDefaultPlanningModel={props.onSetDefaultPlanningModel}
        setDefaultImplementationProvider={props.onSetDefaultImplementationProvider}
        setDefaultImplementationModel={props.onSetDefaultImplementationModel}
        setDefaultRouterProvider={props.onSetDefaultRouterProvider}
        setDefaultRouterModel={props.onSetDefaultRouterModel}
        setDefaultReviewerProvider={props.onSetDefaultReviewerProvider}
        setDefaultReviewerModel={props.onSetDefaultReviewerModel}
        setDefaultInvestigatorProvider={props.onSetDefaultInvestigatorProvider}
        setDefaultInvestigatorModel={props.onSetDefaultInvestigatorModel}
        setDefaultPlanningNoToolGuardMode={props.onSetDefaultPlanningNoToolGuardMode}
        quickStartMode={props.quickStartMode}
        setQuickStartMode={props.onSetQuickStartMode}
        quickStartMaxPreDelegationToolCalls={props.quickStartMaxPreDelegationToolCalls}
        setQuickStartMaxPreDelegationToolCalls={props.onSetQuickStartMaxPreDelegationToolCalls}
        adaptiveConcurrency={props.adaptiveConcurrency}
        setAdaptiveConcurrency={props.onSetAdaptiveConcurrency}
        batchConcurrency={props.batchConcurrency}
        setBatchConcurrency={props.onSetBatchConcurrency}
        batchMinConcurrency={props.batchMinConcurrency}
        setBatchMinConcurrency={props.onSetBatchMinConcurrency}
        enableTrivialTaskGate={props.enableTrivialTaskGate}
        setEnableTrivialTaskGate={props.onSetEnableTrivialTaskGate}
        trivialTaskMaxPromptLength={props.trivialTaskMaxPromptLength}
        setTrivialTaskMaxPromptLength={props.onSetTrivialTaskMaxPromptLength}
        observerShowFindings={props.observerShowFindings}
        setObserverShowFindings={props.onSetObserverShowFindings}
        onSettingsSaveStatus={props.onSettingsSaveStatus}
      />
    );
  }

  const chatPanel = (
    <ChatPanel
      messages={props.chatMessages}
      isStreaming={props.chatIsStreaming}
      activeMessageId={props.chatActiveMessageId}
      firstTokenLatencyMs={props.chatFirstTokenLatencyMs}
      waitingForFirstToken={props.chatWaitingForFirstToken}
      activeToolCalls={props.chatActiveToolCalls}
      onApprovePlan={props.onApprovePlan}
      onRejectPlan={props.onRejectPlan}
      onOpenLlmControls={props.onOpenLlmControls}
      isDark={props.isDark}
      sessionId={props.selectedSessionId}
      selectedSession={props.selectedSession}
      sessionPrompt={props.selectedSession?.prompt}
      sessionStatus={props.selectedSession?.status}
      sessionModel={props.workModel}
      sessionProvider={props.workProvider}
      composerMode={props.composerMode}
      workspaces={props.workspaces}
      workWorkspaceId={props.workWorkspaceId}
      planningNoToolGuardMode={props.planningNoToolGuardMode}
      autoApprove={props.autoApprove}
      planningProvider={props.workPlanningProvider}
      planningModel={props.workPlanningModel}
      composer={(
        <ComposerPanel
          selectedSession={props.selectedSession}
          selectedSessionId={props.selectedSessionId}
          selectedSessionRunning={props.selectedSessionRunning}
          selectedLlmStatus={props.selectedLlmStatus}
          composerMode={props.composerMode}
          workspaces={props.workspaces}
          workWorkspaceId={props.workWorkspaceId}
          workProvider={props.workProvider}
          workModel={props.workModel}
          autoApprove={props.autoApprove}
          composerText={props.composerText}
          setComposerText={props.setComposerText}
          composerImages={props.composerImages}
          removeComposerAttachment={props.removeComposerAttachment}
          hasComposerContent={props.hasComposerContent}
          onComposerPaste={props.onComposerPaste}
          onStop={props.onStop}
          onApprovePlan={props.onApprovePlan}
          onRejectPlan={props.onRejectPlan}
          onSendChat={props.onSendChat}
        />
      )}
    />
  );

  return (
    <div className="flex h-full flex-1">
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
        <GraphTabView
          selectedSession={props.selectedSession}
          selectedSessionRunning={props.selectedSessionRunning}
          selectedFailureType={props.selectedFailureType}
          selectedLlmStatus={props.selectedLlmStatus}
          nodeTokenStreams={props.nodeTokenStreams}
          isDark={props.isDark}
          selectedSessionId={props.selectedSessionId}
          todos={props.todos}
          todoInput={props.todoInput}
          setTodoInput={props.setTodoInput}
          onAddTodo={props.onAddTodo}
          onToggleTodo={props.onToggleTodo}
          chatOverlay={null}
          observerState={props.observerState}
        />
      </div>
      <div className="flex w-[420px] shrink-0 flex-col border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {chatPanel}
      </div>
    </div>
  );
}