import type { SessionSidebarProps } from '../components/SessionSidebar';
import type { AppMainContentProps } from '../components/AppMainContent';
import type { LlmControlsModalProps } from '../components/overlays/LlmControlsModal';

export type AppShellProps = {
  sessionSidebarProps: SessionSidebarProps;
  mainContentProps: AppMainContentProps;
  llmModalProps: LlmControlsModalProps;
  errorMessage: string;
  warningMessage: string;
  warningActionLabel: string;
  onWarningConfirm: () => void;
  onWarningDismiss: () => void;
};