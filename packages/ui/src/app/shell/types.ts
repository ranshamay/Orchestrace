import type { SessionSidebarProps } from '../components/SessionSidebar';
import type { AppMainContentProps } from '../components/AppMainContent';
import type { LlmControlsModalProps } from '../components/overlays/LlmControlsModal';
import type { SettingsSaveToastState } from '../components/overlays/SettingsSaveToast';

export type AppShellProps = {
  sessionSidebarProps: SessionSidebarProps;
  mainContentProps: AppMainContentProps;
  llmModalProps: LlmControlsModalProps;
  errorMessage: string;
  warningMessage?: string;
  onConfirmWarning?: () => void;
  onDismissWarning?: () => void;
  settingsSaveToastState: SettingsSaveToastState;
  settingsSaveToastMessage: string;
};