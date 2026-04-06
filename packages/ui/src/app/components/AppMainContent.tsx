import type { AgentTodo, ProviderInfo, SessionObserverState, WorkSession, Workspace } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode, FailureType, LlmSessionStatus, NodeTokenStream, TimelineItem } from '../types';
import type { SettingsSaveToastState } from './overlays/SettingsSaveToast';
import { GraphTabView } from './graph/GraphTabView';
import { TimelinePanel } from './work/TimelinePanel';
import { ComposerPanel } from './work/ComposerPanel';
import { SettingsTabView } from './settings/SettingsTabView';
import { FloatingChatOverlay } from './layout/FloatingChatOverlay';

export type AppMainContentProps = {
  activeTab: 'graph' | 'settings';
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
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: ComposerImageAttachment[];
  removeComposerAttachment: (id: string) => void;
  hasComposerContent: boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  onStartFromComposer: () => Promise<void>;
  onSendChat: () => Promise<void>;
  onStop: () => Promise<void>;
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  activeWorkspaceId: string;
  defaultProvider: string;
  defaultModel: string;
  onSetDefaultProvider: (next: string) => void;
  onSetDefaultModel: (next: string) => void;
  observerShowFindings: boolean;
  onSetObserverShowFindings: (next: boolean) => void;
  onSettingsSaveStatus: (state: Exclude<SettingsSaveToastState, 'idle'>, message: string) => void;
  nodeTokenStreams: Record<string, NodeTokenStream>;
  observerState: SessionObserverState | null;
  copyTraceState: 'idle' | 'copied' | 'failed';
  onCopyTrace: () => void;
};

export function AppMainContent(props: AppMainContentProps) {
  if (props.activeTab !== 'graph') {
    return (
      <SettingsTabView
        providers={props.providers}
        providerStatuses={props.providerStatuses}
        workspaces={props.workspaces}
        activeWorkspaceId={props.activeWorkspaceId}
        defaultProvider={props.defaultProvider}
        defaultModel={props.defaultModel}
        setDefaultProvider={props.onSetDefaultProvider}
        setDefaultModel={props.onSetDefaultModel}
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
        selectedFailureType={props.selectedFailureType}
        selectedLlmStatus={props.selectedLlmStatus}
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
            onStartFromComposer={props.onStartFromComposer}
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
    />
  );
}