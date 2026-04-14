import type { AppMainContentProps } from '../components/AppMainContent';
import type { LlmControlsModalProps } from '../components/overlays/LlmControlsModal';
import type { SettingsSaveToastState } from '../components/overlays/SettingsSaveToast';
import type { WorkSession } from '../../lib/api';
import type { Tab, ThemeMode } from '../types';

export type ShellSidebarProps = {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  theme: ThemeMode;
  setTheme: (updater: (current: ThemeMode) => ThemeMode) => void;
  sessions: WorkSession[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => Promise<void>;
  onRetrySession: (id: string) => Promise<void>;
};

export type AppShellProps = {
  sessionSidebarProps: ShellSidebarProps;
  mainContentProps: AppMainContentProps;
  llmModalProps: LlmControlsModalProps;
  newPromptModalProps: {
    isOpen: boolean;
    prompt: string;
    onChangePrompt: (next: string) => void;
    onClose: () => void;
    onSubmit: () => void;
  };
  authUser: {

    email: string;
    name?: string;
    picture?: string;
  } | null;
  onLogout: () => void;
  errorMessage: string;
  warningMessage: string;
  warningActionLabel: string;
  onWarningConfirm: () => void;
  onWarningDismiss: () => void;
  settingsSaveToastState: SettingsSaveToastState;
  settingsSaveToastMessage: string;
};