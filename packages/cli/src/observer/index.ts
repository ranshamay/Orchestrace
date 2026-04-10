export { ObserverDaemon } from './daemon.js';
export type { ObserverDaemonOptions } from './daemon.js';
export { SessionObserver } from './session-observer.js';
export type { SessionObserverState, RealtimeFinding, ObserverSessionStatus, ObserverEventEmitter } from './session-observer.js';
export type { ObserverConfig, FindingRecord, ObserverFinding } from './types.js';
export { DEFAULT_OBSERVER_CONFIG } from './types.js';
export { BackendLogger } from './backend-logger.js';
export type { BackendLoggerOptions } from './backend-logger.js';
export { LogWatcher } from './log-watcher.js';
export type {
  LogWatcherState,
  LogFinding,
  LogFindingCategory,
  LogWatcherStatus,
  LogWatcherRuntimeError,
} from './log-watcher.js';
export { verifyFindingAgainstCode } from './verifier.js';
export type { VerificationResult } from './verifier.js';
export { groupVerifiedFindings } from './grouper.js';
export type { FindingGroupDecision } from './grouper.js';
export { evaluateSpawnGate, listRemoteBranches } from './gate.js';
export type { ObserverOutcomeStats, SpawnGateDecision } from './gate.js';
export { OutcomeTracker } from './outcomes.js';

