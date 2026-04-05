import { AppMainContent } from '../components/AppMainContent';
import { SessionSidebar } from '../components/SessionSidebar';
import { ErrorToast } from '../components/overlays/ErrorToast';
import { LlmControlsModal } from '../components/overlays/LlmControlsModal';
import type { AppShellProps } from './types';

export function AppShell({ sessionSidebarProps, mainContentProps, llmModalProps, errorMessage }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 md:flex-row">
      <main className="min-w-0 flex-1">
        <AppMainContent {...mainContentProps} />
      </main>
      <SessionSidebar {...sessionSidebarProps} />
      <ErrorToast message={errorMessage} />
      <LlmControlsModal {...llmModalProps} />
    </div>
  );
}