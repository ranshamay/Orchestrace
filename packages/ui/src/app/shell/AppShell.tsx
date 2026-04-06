import { AppMainContent } from '../components/AppMainContent';
import { SessionsRail } from '../components/layout/SessionsRail';
import { TopBar } from '../components/layout/TopBar';
import { ErrorToast } from '../components/overlays/ErrorToast';
import { LlmControlsModal } from '../components/overlays/LlmControlsModal';
import { SettingsSaveToast } from '../components/overlays/SettingsSaveToast';
import type { AppShellProps } from './types';

export function AppShell({
  sessionSidebarProps,
  mainContentProps,
  llmModalProps,
  errorMessage,
  settingsSaveToastState,
  settingsSaveToastMessage,
}: AppShellProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <TopBar
        theme={sessionSidebarProps.theme}
        setTheme={sessionSidebarProps.setTheme}
        onOpenSettings={() => sessionSidebarProps.setActiveTab('settings')}
        onOpenLlmControls={mainContentProps.onOpenLlmControls}
      />
      <div className="flex min-h-0 flex-1">
        <SessionsRail
          sessions={sessionSidebarProps.sessions}
          selectedSessionId={sessionSidebarProps.selectedSessionId}
          onSelectSession={(id) => {
            sessionSidebarProps.setActiveTab('graph');
            sessionSidebarProps.onSelectSession(id);
          }}
          onNewSession={sessionSidebarProps.onNewSession}
          onDeleteSession={sessionSidebarProps.onDeleteSession}
          onRetrySession={sessionSidebarProps.onRetrySession}
        />
        <main className="min-w-0 flex-1">
          <AppMainContent {...mainContentProps} />
        </main>
      </div>
      <SettingsSaveToast state={settingsSaveToastState} message={settingsSaveToastMessage} />
      <ErrorToast message={errorMessage} />
      <LlmControlsModal {...llmModalProps} />
    </div>
  );
}