export const SESSION_LIFECYCLE_PHASES = [
  'VALIDATING',
  'SETTING_UP',
  'DISPATCHING',
  'EXECUTING',
  'COMPLETING',
  'CLEANING_UP',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type SessionLifecyclePhase = typeof SESSION_LIFECYCLE_PHASES[number];

export class SessionLifecycleError extends Error {
  readonly type: 'illegal_transition' | 'precondition_failed' | 'phase_failed' | 'cleanup_failed';
  readonly phase: SessionLifecyclePhase;
  readonly causeError?: unknown;

  constructor(
    message: string,
    options: {
      type: 'illegal_transition' | 'precondition_failed' | 'phase_failed' | 'cleanup_failed';
      phase: SessionLifecyclePhase;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'SessionLifecycleError';
    this.type = options.type;
    this.phase = options.phase;
    this.causeError = options.cause;
  }
}

export interface SessionLifecycleCleanupError {
  phase: SessionLifecyclePhase;
  actionLabel: string;
  error: unknown;
}

export interface SessionLifecycleCleanupAction {
  phase: SessionLifecyclePhase;
  label: string;
  run: () => Promise<void> | void;
}

export interface SessionLifecycleDiagnostics {
  currentPhase: SessionLifecyclePhase;
  enteredPhases: SessionLifecyclePhase[];
  lastFailure?: {
    phase: SessionLifecyclePhase;
    type: SessionLifecycleError['type'];
    message: string;
  };
  cleanupErrors: SessionLifecycleCleanupError[];
}

const TERMINAL_PHASES = new Set<SessionLifecyclePhase>(['COMPLETED', 'FAILED', 'CANCELLED']);

const LEGAL_TRANSITIONS: Record<SessionLifecyclePhase, Set<SessionLifecyclePhase>> = {
  VALIDATING: new Set(['SETTING_UP', 'FAILED', 'CANCELLED', 'CLEANING_UP']),
  SETTING_UP: new Set(['DISPATCHING', 'FAILED', 'CANCELLED', 'CLEANING_UP']),
  DISPATCHING: new Set(['EXECUTING', 'FAILED', 'CANCELLED', 'CLEANING_UP']),
  EXECUTING: new Set(['COMPLETING', 'FAILED', 'CANCELLED', 'CLEANING_UP']),
  COMPLETING: new Set(['CLEANING_UP', 'COMPLETED', 'FAILED', 'CANCELLED']),
  CLEANING_UP: new Set(['COMPLETED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};

export class SessionLifecycle {
  private current: SessionLifecyclePhase;
  private readonly entered: SessionLifecyclePhase[];
  private readonly cleanupStack: SessionLifecycleCleanupAction[];
  private readonly cleanupErrors: SessionLifecycleCleanupError[];
  private cleanupInFlight?: Promise<void>;
  private cleanupExecuted = false;
  private lastFailure?: SessionLifecycleDiagnostics['lastFailure'];


  constructor(initialPhase: SessionLifecyclePhase = 'VALIDATING') {
    this.current = initialPhase;
    this.entered = [initialPhase];
    this.cleanupStack = [];
    this.cleanupErrors = [];
  }

  get phase(): SessionLifecyclePhase {
    return this.current;
  }

  get diagnostics(): SessionLifecycleDiagnostics {
    return {
      currentPhase: this.current,
      enteredPhases: [...this.entered],
      lastFailure: this.lastFailure ? { ...this.lastFailure } : undefined,
      cleanupErrors: [...this.cleanupErrors],
    };
  }

  canTransitionTo(next: SessionLifecyclePhase): boolean {
    return LEGAL_TRANSITIONS[this.current].has(next);
  }

  enterPhase(next: SessionLifecyclePhase, options: {
    precondition?: () => boolean | Promise<boolean>;
    preconditionMessage?: string;
  } = {}): Promise<void> {
    return this.enterPhaseInternal(next, options.precondition, options.preconditionMessage);
  }

  registerCleanup(phase: SessionLifecyclePhase, label: string, run: () => Promise<void> | void): void {
    this.cleanupStack.push({ phase, label, run });
  }

  async failAt(phase: SessionLifecyclePhase, message: string, cause?: unknown): Promise<SessionLifecycleError> {
    if (!TERMINAL_PHASES.has(this.current) && this.current !== 'CLEANING_UP' && this.current !== phase) {
      try {
        await this.enterPhase(phase);
      } catch {
        // keep original phase if we cannot transition; capture failure below
      }
    }
    this.lastFailure = { phase, type: 'phase_failed', message };

    const error = new SessionLifecycleError(message, {
      type: 'phase_failed',
      phase,
      cause,
    });

    await this.cleanup();
    return error;
  }

      async cleanup(): Promise<void> {
    if (this.cleanupExecuted) {
      return;
    }

    if (this.cleanupInFlight) {
      await this.cleanupInFlight;
      return;
    }

    this.cleanupInFlight = (async () => {
      if (!TERMINAL_PHASES.has(this.current) && this.current !== 'CLEANING_UP') {
        await this.enterPhaseInternal('CLEANING_UP');
      }

      while (this.cleanupStack.length > 0) {
        const action = this.cleanupStack.pop()!;
        try {
          await action.run();
        } catch (error) {
          this.cleanupErrors.push({
            phase: action.phase,
            actionLabel: action.label,
            error,
          });
        }
      }

      this.cleanupExecuted = true;
    })();

    try {
      await this.cleanupInFlight;
    } finally {
      this.cleanupInFlight = undefined;
    }
  }


  
  async complete(status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    if (this.current !== 'CLEANING_UP' && !TERMINAL_PHASES.has(this.current)) {
      await this.cleanup();
    }
    await this.enterPhaseInternal(status);
  }

  private async enterPhaseInternal(
    next: SessionLifecyclePhase,
    precondition?: () => boolean | Promise<boolean>,
    preconditionMessage?: string,
  ): Promise<void> {
    if (this.current === next) {
      if (precondition) {
        const ok = await precondition();
        if (!ok) {
          const failure = preconditionMessage ?? `Precondition failed for phase ${next}.`;
          this.lastFailure = { phase: next, type: 'precondition_failed', message: failure };
          throw new SessionLifecycleError(failure, {
            type: 'precondition_failed',
            phase: next,
          });
        }
      }
      return;
    }

    if (!LEGAL_TRANSITIONS[this.current].has(next)) {
      const message = `Illegal lifecycle transition: ${this.current} -> ${next}`;
      this.lastFailure = { phase: this.current, type: 'illegal_transition', message };
      throw new SessionLifecycleError(message, {
        type: 'illegal_transition',
        phase: this.current,
      });
    }

    if (precondition) {
      const ok = await precondition();
      if (!ok) {
        const failure = preconditionMessage ?? `Precondition failed for phase ${next}.`;
        this.lastFailure = { phase: next, type: 'precondition_failed', message: failure };
        throw new SessionLifecycleError(failure, {
          type: 'precondition_failed',
          phase: next,
        });
      }
    }

    this.current = next;
    this.entered.push(next);
  }
}