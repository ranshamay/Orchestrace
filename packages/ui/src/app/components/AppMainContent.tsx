import type { AgentModels, AgentTodo, ProviderInfo, SessionObserverState, WorkSession, Workspace } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode, FailureType, LlmSessionStatus, NodeTokenStream, TimelineItem } from '../types';
import type { SettingsSaveToastState } from './overlays/SettingsSaveToast';
import { GraphTabView } from './graph/GraphTabView';
import { TimelinePanel } from './work/TimelinePanel';
import { ComposerPanel } from './work/ComposerPanel';
import { LogsTabView } from './work/LogsTabView';
import { SettingsTabView } from './settings/SettingsTabView';
import { FloatingChatOverlay } from './layout/FloatingChatOverlay';

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
        observerShowFindings={props.observerShowFindings}
        setObserverShowFindings={props.onSetObserverShowFindings}
        onSettingsSaveStatus={props.onSettingsSaveStatus}
      />
    );
  }

  const chatOverlay = (
    <FloatingChatOverlay hasSession={Boolean(props.selectedSessionId)}>
      <TimelinePanel
        selectedSessionId={props.selectedSessionId}
        selectedSession={props.selectedSession}
        selectedSessionRunning={props.selectedSessionRunning}
        showToolsPanel={props.showToolsPanel}
        setShowToolsPanel={props.setShowToolsPanel}
        toolsMode={props.toolsMode}
        availableTools={props.availableTools}
        isToolsLoading={props.isToolsLoading}
        toolsLoadError={props.toolsLoadError}
        timelineContainerRef={props.timelineContainerRef}
        followTimelineTail={props.followTimelineTail}
        jumpToLatest={props.jumpToLatest}
        onTimelineScroll={props.onTimelineScroll}
        timelineItems={props.timelineItems}
        composer={(
          <ComposerPanel
            selectedSession={props.selectedSession}
            selectedSessionId={props.selectedSessionId}
            selectedSessionRunning={props.selectedSessionRunning}
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
            onSendChat={props.onSendChat}
          />
        )}
        isDark={props.isDark}
        copyTraceState={props.copyTraceState}
        onCopyTrace={props.onCopyTrace}
      />
    </FloatingChatOverlay>
  );

  return (
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
      chatOverlay={chatOverlay}
      observerState={props.observerState}
      workspaces={props.workspaces}
      workWorkspaceId={props.workWorkspaceId}
      workPlanningProvider={props.workPlanningProvider}
      workPlanningModel={props.workPlanningModel}
      workProvider={props.workProvider}
      workModel={props.workModel}
      planningNoToolGuardMode={props.planningNoToolGuardMode}
      autoApprove={props.autoApprove}
      composerMode={props.composerMode}
    />
  );
}