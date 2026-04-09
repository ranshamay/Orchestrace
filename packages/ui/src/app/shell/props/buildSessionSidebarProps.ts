import type { SessionSidebarProps } from '../../components/SessionSidebar';
import type { FailureType, Tab, ThemeMode } from '../../types';

type Params = {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  theme: ThemeMode;
  setTheme: SessionSidebarProps['setTheme'];
  sessions: SessionSidebarProps['sessions'];
  selectedSessionId: string;
  setSessionSelection: (id: string) => void;
  onStartNewSessionDraft: () => void;
  setCopyTraceState: (next: { sessionId: string; state: 'idle' | 'copied' | 'failed' }) => void;
  actions: {
    handleDelete: (sessionId?: string) => Promise<void>;
    handleRetrySession: (sessionId: string) => Promise<void>;
    handleCopyTraceSession: (sessionId: string) => Promise<'idle' | 'copied' | 'failed'>;
  };
  copyTraceState: { sessionId: string; state: 'idle' | 'copied' | 'failed' };
      sessionStatusSummary: { total: number; running: number; completed: number; failed: number; cancelled: number; merged: number; overall: string };
  failureTypeSummary: Array<[FailureType, number]>;
};

export function buildSessionSidebarProps(params: Params): SessionSidebarProps {
  return {
    activeTab: params.activeTab,
    setActiveTab: params.setActiveTab,
    theme: params.theme,
    setTheme: params.setTheme,
    sessions: params.sessions,
    selectedSessionId: params.selectedSessionId,
    onSelectSession: params.setSessionSelection,
    onNewSession: params.onStartNewSessionDraft,
    onDeleteSession: async (sessionId) => params.actions.handleDelete(sessionId),
    onRetrySession: async (sessionId) => params.actions.handleRetrySession(sessionId),
    onCopyTraceSession: async (sessionId) => {
      const state = await params.actions.handleCopyTraceSession(sessionId);
      params.setCopyTraceState({ sessionId, state });
    },
    copyTraceState: params.copyTraceState,
    sessionStatusSummary: params.sessionStatusSummary,
    failureTypeSummary: params.failureTypeSummary,
  };
}