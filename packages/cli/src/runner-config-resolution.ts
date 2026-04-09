export type PlanningNoToolGuardMode = 'enforce' | 'warn';

export interface ResolutionConflict<T> {
  settingKey: string;
  configValue: T;
  envVarName: string;
  envValue: T;
}

export interface ResolutionResult<T> {
  value: T;
  source: 'config' | 'env' | 'default';
  conflict?: ResolutionConflict<T>;
}

export interface RunnerPolicyInput {
  configQuickStartMode: unknown;
  envQuickStartMode: string | undefined;
  configQuickStartMaxPreDelegationToolCalls: unknown;
  envQuickStartMaxPreDelegationToolCalls: string | undefined;
  configPlanningNoToolGuardMode: unknown;
  envPlanningNoToolGuardMode: string | undefined;
}

export interface RunnerPolicyResolution {
  quickStartMode: ResolutionResult<boolean>;
  quickStartMaxPreDelegationToolCalls: ResolutionResult<number>;
  planningNoToolGuardMode: ResolutionResult<PlanningNoToolGuardMode>;
}

/**
 * Standardized precedence policy for runner settings:
 *   1) valid config value
 *   2) valid env value
 *   3) default
 *
 * If config and env are both valid and differ, config still wins and a conflict is returned.
 */
export function resolveRunnerPolicy(input: RunnerPolicyInput): RunnerPolicyResolution {
  return {
    quickStartMode: resolveConfigEnvDefault<boolean>({
      settingKey: 'quickStartMode',
      envVarName: 'ORCHESTRACE_QUICK_START_MODE',
      configRaw: input.configQuickStartMode,
      envRaw: input.envQuickStartMode,
      defaultValue: false,
      parseConfig: parseBooleanConfig,
      parseEnv: parseBooleanEnv,
    }),
    quickStartMaxPreDelegationToolCalls: resolveConfigEnvDefault<number>({
      settingKey: 'quickStartMaxPreDelegationToolCalls',
      envVarName: 'ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS',
      configRaw: input.configQuickStartMaxPreDelegationToolCalls,
      envRaw: input.envQuickStartMaxPreDelegationToolCalls,
      defaultValue: 3,
      parseConfig: parsePositiveIntConfig,
      parseEnv: parsePositiveIntEnv,
    }),
    planningNoToolGuardMode: resolveConfigEnvDefault<PlanningNoToolGuardMode>({
      settingKey: 'planningNoToolGuardMode',
      envVarName: 'ORCHESTRACE_PLANNING_NO_TOOL_GUARD_MODE',
      configRaw: input.configPlanningNoToolGuardMode,
      envRaw: input.envPlanningNoToolGuardMode,
      defaultValue: 'enforce',
      parseConfig: normalizePlanningNoToolGuardMode,
      parseEnv: normalizePlanningNoToolGuardMode,
    }),
  };
}

interface ResolveConfigEnvDefaultParams<T> {
  settingKey: string;
  envVarName: string;
  configRaw: unknown;
  envRaw: unknown;
  defaultValue: T;
  parseConfig: (value: unknown) => T | undefined;
  parseEnv: (value: unknown) => T | undefined;
}

function resolveConfigEnvDefault<T>(params: ResolveConfigEnvDefaultParams<T>): ResolutionResult<T> {
  const configValue = params.parseConfig(params.configRaw);
  const envValue = params.parseEnv(params.envRaw);
  const conflict = configValue !== undefined
    && envValue !== undefined
    && !Object.is(configValue, envValue)
    ? {
      settingKey: params.settingKey,
      configValue,
      envVarName: params.envVarName,
      envValue,
    }
    : undefined;

  if (configValue !== undefined) {
    return {
      value: configValue,
      source: 'config',
      conflict,
    };
  }

  if (envValue !== undefined) {
    return {
      value: envValue,
      source: 'env',
    };
  }

  return {
    value: params.defaultValue,
    source: 'default',
  };
}

function parsePositiveIntEnv(raw: unknown): number | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  return parsePositiveIntLike(raw);
}

function parsePositiveIntConfig(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  }
  if (typeof raw === 'string') {
    return parsePositiveIntLike(raw);
  }
  return undefined;
}

function parsePositiveIntLike(raw: string): number | undefined {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return undefined;
}

function parseBooleanConfig(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    return parseBooleanLike(raw);
  }
  return undefined;
}

function parseBooleanEnv(raw: unknown): boolean | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  return parseBooleanLike(raw);
}

function parseBooleanLike(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function normalizePlanningNoToolGuardMode(value: unknown): PlanningNoToolGuardMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'warn') {
    return normalized;
  }

  return undefined;
}