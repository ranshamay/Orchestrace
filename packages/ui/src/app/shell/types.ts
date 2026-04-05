import type { SessionSidebarProps } from '../components/SessionSidebar';
import type { AppMainContentProps } from '../components/AppMainContent';
import type { LlmControlsModalProps } from '../components/overlays/LlmControlsModal';

export type AppShellProps = {
  sessionSidebarProps: SessionSidebarProps;
  mainContentProps: AppMainContentProps;
  llmModalProps: LlmControlsModalProps;
  errorMessage: string;
  sessionSidebarWidthPx: number;
  onSetSessionSidebarWidthPx: (next: number) => void;
};