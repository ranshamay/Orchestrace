import type { AgentTodo, GitWorktreeInfo, ProviderInfo, WorkSession, Workspace } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode, FailureType, LlmSessionStatus, TimelineItem } from '../types';
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
  executionContext: 'workspace' | 'git-worktree';
  selectedWorktreePath: string;
  availableWorktrees: GitWorktreeInfo[];
  useWorktree: boolean;
  composerText: string;
  setComposerText: (value: string) => void;
  composerImages: ComposerImageAttachment[];
  removeComposerAttachment: (id: string) => void;
  hasComposerContent: boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  onRun: () => Promise<void>;
  onStop: () => Promise<void>;
  copyTraceState: 'idle' | 'copied' | 'failed';
  onCopyTrace: () => void;
  providers: ProviderInfo[];
  providerStatuses: Array<{ provider: string; source: string }>;
  activeWorkspaceId: string;
  onSetExecutionContext: (next: 'workspace' | 'git-worktree') => void;
  onSetSelectedWorktreePath: (next: string) => void;
};

export function AppMainContent(props: AppMainContentProps) {
  if (props.activeTab !== 'graph') {
    return (
      <SettingsTabView
        providers={props.providers}
        providerStatuses={props.providerStatuses}
        workspaces={props.workspaces}
        activeWorkspaceId={props.activeWorkspaceId}
        executionContext={props.executionContext}
        setExecutionContext={props.onSetExecutionContext}
        selectedWorktreePath={props.selectedWorktreePath}
        setSelectedWorktreePath={props.onSetSelectedWorktreePath}
        availableWorktrees={props.availableWorktrees}
      />
    );
  }

  const chatOverlay = (
    <FloatingChatOverlay hasSession={!!props.selectedSessionId}>
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
        copyTraceState={props.copyTraceState}
        onCopyTrace={props.onCopyTrace}
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
            executionContext={props.executionContext}
            selectedWorktreePath={props.selectedWorktreePath}
            availableWorktrees={props.availableWorktrees}
            useWorktree={props.useWorktree}
            composerText={props.composerText}
            setComposerText={props.setComposerText}
            composerImages={props.composerImages}
            removeComposerAttachment={props.removeComposerAttachment}
            hasComposerContent={props.hasComposerContent}
            onComposerPaste={props.onComposerPaste}
            onRun={props.onRun}
            onStop={props.onStop}
          />
        )}
        isDark={props.isDark}
      />
    </FloatingChatOverlay>
  );

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
      chatOverlay={chatOverlay}
    />
  );
}