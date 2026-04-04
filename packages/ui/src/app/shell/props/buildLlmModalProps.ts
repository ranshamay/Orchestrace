import type { LlmControlsModalProps } from '../../components/overlays/LlmControlsModal';

type Params = {
  isOpen: boolean;
  providers: LlmControlsModalProps['providers'];
  workspaces: LlmControlsModalProps['workspaces'];
  currentModels: LlmControlsModalProps['currentModels'];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  useWorktree: boolean;
  closeLlmControlsModal: () => void;
  onChangeWorkspace: (workspaceId: string) => void;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onChangeAutoApprove: (next: boolean) => void;
  onChangeUseWorktree: (next: boolean) => void;
};

export function buildLlmModalProps(params: Params): LlmControlsModalProps {
  return {
    isOpen: params.isOpen,
    providers: params.providers,
    workspaces: params.workspaces,
    currentModels: params.currentModels,
    workWorkspaceId: params.workWorkspaceId,
    workProvider: params.workProvider,
    workModel: params.workModel,
    autoApprove: params.autoApprove,
    useWorktree: params.useWorktree,
    onClose: params.closeLlmControlsModal,
    onChangeWorkspace: params.onChangeWorkspace,
    onChangeProvider: params.onChangeProvider,
    onChangeModel: params.onChangeModel,
    onChangeAutoApprove: params.onChangeAutoApprove,
    onChangeUseWorktree: params.onChangeUseWorktree,
  };
}