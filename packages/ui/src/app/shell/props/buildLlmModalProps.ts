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
  executionContext: LlmControlsModalProps['executionContext'];
  selectedWorktreePath: string;
  availableWorktrees: LlmControlsModalProps['availableWorktrees'];
  useWorktree: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  closeLlmControlsModal: () => void;
  onChangeWorkspace: (workspaceId: string) => void;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onChangeAutoApprove: (next: boolean) => void;
  onChangeExecutionContext: LlmControlsModalProps['onChangeExecutionContext'];
  onChangeSelectedWorktreePath: LlmControlsModalProps['onChangeSelectedWorktreePath'];
  onChangeAdaptiveConcurrency: (next: boolean) => void;
  onChangeBatchConcurrency: (next: number) => void;
  onChangeBatchMinConcurrency: (next: number) => void;
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
    executionContext: params.executionContext,
    selectedWorktreePath: params.selectedWorktreePath,
    availableWorktrees: params.availableWorktrees,
    useWorktree: params.useWorktree,
    adaptiveConcurrency: params.adaptiveConcurrency,
    batchConcurrency: params.batchConcurrency,
    batchMinConcurrency: params.batchMinConcurrency,
    onClose: params.closeLlmControlsModal,
    onChangeWorkspace: params.onChangeWorkspace,
    onChangeProvider: params.onChangeProvider,
    onChangeModel: params.onChangeModel,
    onChangeAutoApprove: params.onChangeAutoApprove,
    onChangeExecutionContext: params.onChangeExecutionContext,
    onChangeSelectedWorktreePath: params.onChangeSelectedWorktreePath,
    onChangeAdaptiveConcurrency: params.onChangeAdaptiveConcurrency,
    onChangeBatchConcurrency: params.onChangeBatchConcurrency,
    onChangeBatchMinConcurrency: params.onChangeBatchMinConcurrency,
  };
}