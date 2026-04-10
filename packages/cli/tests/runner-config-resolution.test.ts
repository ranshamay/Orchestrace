import { describe, expect, it } from 'vitest';
import { resolveRunnerPolicy } from '../src/runner-config-resolution.js';

describe('runner config resolution policy', () => {
  it('prefers valid config values over env values', () => {
        const resolved = resolveRunnerPolicy({
      configQuickStartMode: false,
      envQuickStartMode: 'true',
      configQuickStartMaxPreDelegationToolCalls: 9,
      envQuickStartMaxPreDelegationToolCalls: '2',
      configPlanningMaxInvestigativeToolCalls: 14,
      envPlanningMaxInvestigativeToolCalls: '8',
      configPlanningNoToolGuardMode: 'warn',
      envPlanningNoToolGuardMode: 'enforce',
    });


    expect(resolved.quickStartMode.value).toBe(false);
    expect(resolved.quickStartMode.source).toBe('config');
        expect(resolved.quickStartMaxPreDelegationToolCalls.value).toBe(9);
    expect(resolved.quickStartMaxPreDelegationToolCalls.source).toBe('config');
    expect(resolved.planningMaxInvestigativeToolCalls.value).toBe(14);
    expect(resolved.planningMaxInvestigativeToolCalls.source).toBe('config');
    expect(resolved.planningNoToolGuardMode.value).toBe('warn');

    expect(resolved.planningNoToolGuardMode.source).toBe('config');
  });

  it('uses valid env values when config is missing or invalid', () => {
        const resolved = resolveRunnerPolicy({
      configQuickStartMode: 'invalid-bool',
      envQuickStartMode: 'yes',
      configQuickStartMaxPreDelegationToolCalls: 0,
      envQuickStartMaxPreDelegationToolCalls: '7',
      configPlanningMaxInvestigativeToolCalls: 0,
      envPlanningMaxInvestigativeToolCalls: '11',
      configPlanningNoToolGuardMode: 'invalid-mode',
      envPlanningNoToolGuardMode: 'warn',
    });


    expect(resolved.quickStartMode.value).toBe(true);
    expect(resolved.quickStartMode.source).toBe('env');
        expect(resolved.quickStartMaxPreDelegationToolCalls.value).toBe(7);
    expect(resolved.quickStartMaxPreDelegationToolCalls.source).toBe('env');
    expect(resolved.planningMaxInvestigativeToolCalls.value).toBe(11);
    expect(resolved.planningMaxInvestigativeToolCalls.source).toBe('env');
    expect(resolved.planningNoToolGuardMode.value).toBe('warn');

    expect(resolved.planningNoToolGuardMode.source).toBe('env');
  });

  it('falls back to defaults when both config and env are absent or invalid', () => {
        const resolved = resolveRunnerPolicy({
      configQuickStartMode: undefined,
      envQuickStartMode: 'maybe',
      configQuickStartMaxPreDelegationToolCalls: -4,
      envQuickStartMaxPreDelegationToolCalls: '0',
      configPlanningMaxInvestigativeToolCalls: -1,
      envPlanningMaxInvestigativeToolCalls: '0',
      configPlanningNoToolGuardMode: undefined,
      envPlanningNoToolGuardMode: 'strict',
    });


    expect(resolved.quickStartMode.value).toBe(false);
    expect(resolved.quickStartMode.source).toBe('default');
        expect(resolved.quickStartMaxPreDelegationToolCalls.value).toBe(3);
    expect(resolved.quickStartMaxPreDelegationToolCalls.source).toBe('default');
    expect(resolved.planningMaxInvestigativeToolCalls.value).toBe(12);
    expect(resolved.planningMaxInvestigativeToolCalls.source).toBe('default');
    expect(resolved.planningNoToolGuardMode.value).toBe('enforce');

    expect(resolved.planningNoToolGuardMode.source).toBe('default');
  });

  it('records conflicts when both config and env are valid but different', () => {
        const resolved = resolveRunnerPolicy({
      configQuickStartMode: true,
      envQuickStartMode: 'false',
      configQuickStartMaxPreDelegationToolCalls: 6,
      envQuickStartMaxPreDelegationToolCalls: '3',
      configPlanningMaxInvestigativeToolCalls: 18,
      envPlanningMaxInvestigativeToolCalls: '12',
      configPlanningNoToolGuardMode: 'enforce',
      envPlanningNoToolGuardMode: 'warn',
    });


    expect(resolved.quickStartMode.conflict).toEqual({
      settingKey: 'quickStartMode',
      configValue: true,
      envVarName: 'ORCHESTRACE_QUICK_START_MODE',
      envValue: false,
    });

    expect(resolved.quickStartMaxPreDelegationToolCalls.conflict).toEqual({
      settingKey: 'quickStartMaxPreDelegationToolCalls',
      configValue: 6,
      envVarName: 'ORCHESTRACE_QUICK_START_MAX_PRE_DELEGATION_TOOL_CALLS',
      envValue: 3,
    });

        expect(resolved.planningMaxInvestigativeToolCalls.conflict).toEqual({
      settingKey: 'planningMaxInvestigativeToolCalls',
      configValue: 18,
      envVarName: 'ORCHESTRACE_PLANNING_MAX_INVESTIGATIVE_TOOL_CALLS',
      envValue: 12,
    });

    expect(resolved.planningNoToolGuardMode.conflict).toEqual({
      settingKey: 'planningNoToolGuardMode',
      configValue: 'enforce',
      envVarName: 'ORCHESTRACE_PLANNING_NO_TOOL_GUARD_MODE',
      envValue: 'warn',
    });

  });

  it('does not record conflict when values are equal', () => {
        const resolved = resolveRunnerPolicy({
      configQuickStartMode: true,
      envQuickStartMode: 'true',
      configQuickStartMaxPreDelegationToolCalls: 5,
      envQuickStartMaxPreDelegationToolCalls: '5',
      configPlanningMaxInvestigativeToolCalls: 12,
      envPlanningMaxInvestigativeToolCalls: '12',
      configPlanningNoToolGuardMode: 'warn',
      envPlanningNoToolGuardMode: 'warn',
    });


        expect(resolved.quickStartMode.conflict).toBeUndefined();
    expect(resolved.quickStartMaxPreDelegationToolCalls.conflict).toBeUndefined();
    expect(resolved.planningMaxInvestigativeToolCalls.conflict).toBeUndefined();
    expect(resolved.planningNoToolGuardMode.conflict).toBeUndefined();

  });
});