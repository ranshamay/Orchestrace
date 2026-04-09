export {
	cleanupWorktree,
	ensureWorktreeDependenciesInstalled,
	ensureWorktreeExists,
	listWorktrees,
	resolveManagedWorktreeBaseDir,
} from './worktree-manager.js';
export type { CleanupWorktreeOptions, EnsureWorktreeOptions, ManagedWorktree } from './worktree-manager.js';
export { createContainer } from './container.js';
export type { ContainerHandle, ContainerConfig } from './container.js';
