import type { AgentTodo, ProviderInfo, WorkSession, Workspace } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode, FailureType, LlmSessionStatus, TimelineItem } from '../types';
import { GraphTabView } from './graph/GraphTabView';
import { TimelinePanel } from './work/TimelinePanel';
import { ComposerPanel } from './work/ComposerPanel';
import { SettingsTabView } from './settings/SettingsTabView';

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
  useWorktree: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: ComposerImageAttachment[];
  removeComposerAttachment: (id: string) => void;
  hasComposerContent: boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  onStartFromComposer: () => Promise<void>;
  onStop: () => Promise<void>;
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  activeWorkspaceId: string;
  onSetUseWorktree: (next: boolean) => void;
  rightPaneWidthPx: number;
  onSetRightPaneWidthPx: (next: number) => void;
};

export function AppMainContent(props: AppMainContentProps) {
  if (props.activeTab !== 'graph') {
    return (
      <SettingsTabView
        providers={props.providers}
        providerStatuses={props.providerStatuses}
        workspaces={props.workspaces}
        activeWorkspaceId={props.activeWorkspaceId}
        useWorktree={props.useWorktree}
        setUseWorktree={props.onSetUseWorktree}
      />
    );
  }

  return (
    <GraphTabView
      selectedSession={props.selectedSession}
      selectedSessionRunning={props.selectedSessionRunning}
      selectedFailureType={props.selectedFailureType}
      selectedLlmStatus={props.selectedLlmStatus}
      isDark={props.isDark}
      selectedSessionId={props.selectedSessionId}
      todos={props.todos}
      todoInput={props.todoInput}
      setTodoInput={props.setTodoInput}
      onAddTodo={props.onAddTodo}
      onToggleTodo={props.onToggleTodo}
      onOpenLlmControls={props.onOpenLlmControls}
      rightPaneWidthPx={props.rightPaneWidthPx}
      onSetRightPaneWidthPx={props.onSetRightPaneWidthPx}
      rightPane={(
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
              useWorktree={props.useWorktree}
              composerText={props.composerText}
              setComposerText={props.setComposerText}
              composerImages={props.composerImages}
              removeComposerAttachment={props.removeComposerAttachment}
              hasComposerContent={props.hasComposerContent}
              onComposerPaste={props.onComposerPaste}
              onStartFromComposer={props.onStartFromComposer}
              onStop={props.onStop}
              onSendChat={props.onStartFromComposer}
            />
          )}
          isDark={props.isDark}
        />
      )}
    />
  );
}