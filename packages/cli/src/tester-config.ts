import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type TesterCategory = 'unit' | 'integration' | 'api' | 'ui' | 'deployment';
export type TesterReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface TesterAgentConfig {
  enabled: boolean;
  provider: string;
  model: string;
  reasoning?: TesterReasoningLevel;
  requireRunTests: boolean;
  enforceUiTestsForUiChanges: boolean;
  requireUiScreenshotsForUiChanges: boolean;
  minUiScreenshotCount: number;
  testCategories: TesterCategory[];
  maxTestRetries: number;
  timeoutMs: number;
  testFilePatterns: string[];
  uiChangePatterns: string[];
  uiTestCommandPatterns: string[];
  approvalThreshold: number;
}

export const DEFAULT_TESTER_AGENT_CONFIG: TesterAgentConfig = {
  enabled: false,
  provider: '',
  model: '',
  requireRunTests: true,
  enforceUiTestsForUiChanges: true,
  requireUiScreenshotsForUiChanges: true,
  minUiScreenshotCount: 2,
  testCategories: ['unit', 'integration'],
  maxTestRetries: 1,
  timeoutMs: 300_000,
  testFilePatterns: ['**/tests/**', '**/*.test.*', '**/*.spec.*'],
  uiChangePatterns: ['packages/ui/**', '**/*.tsx', '**/*.jsx', '**/*.css', '**/*.scss', '**/*.html'],
  uiTestCommandPatterns: ['playwright', 'cypress', 'test:ui', '--ui', '@orchestrace/ui test'],
  approvalThreshold: 1,
};

const TESTER_CONFIG_DIRNAME = 'tester';
const TESTER_CONFIG_FILENAME = 'config.json';

export async function loadTesterAgentConfig(orchestraceDir: string): Promise<TesterAgentConfig> {
  const configPath = resolveTesterConfigPath(orchestraceDir);
  try {
    const raw = await readFile(configPath, 'utf-8');
    return normalizeTesterAgentConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TESTER_AGENT_CONFIG };
  }
}

export async function saveTesterAgentConfig(
  orchestraceDir: string,
  value: unknown,
): Promise<TesterAgentConfig> {
  const normalized = normalizeTesterAgentConfig(value);
  const configPath = resolveTesterConfigPath(orchestraceDir);
  await mkdir(join(orchestraceDir, TESTER_CONFIG_DIRNAME), { recursive: true });
  await writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

export function normalizeTesterAgentConfig(
  value: unknown,
  fallback: TesterAgentConfig = DEFAULT_TESTER_AGENT_CONFIG,
): TesterAgentConfig {
  const record = isRecord(value) ? value : {};

  return {
    enabled: asBoolean(record.enabled, fallback.enabled),
    provider: asString(record.provider).trim() || fallback.provider,
    model: asString(record.model).trim() || fallback.model,
    reasoning: normalizeReasoning(record.reasoning) ?? fallback.reasoning,
    requireRunTests: asBoolean(record.requireRunTests, fallback.requireRunTests),
    enforceUiTestsForUiChanges: asBoolean(
      record.enforceUiTestsForUiChanges,
      fallback.enforceUiTestsForUiChanges,
    ),
    requireUiScreenshotsForUiChanges: asBoolean(
      record.requireUiScreenshotsForUiChanges,
      fallback.requireUiScreenshotsForUiChanges,
    ),
    minUiScreenshotCount: normalizeMinUiScreenshotCount(
      record.minUiScreenshotCount,
      fallback.minUiScreenshotCount,
    ),
    testCategories: normalizeCategories(record.testCategories, fallback.testCategories),
    maxTestRetries: normalizePositiveInt(record.maxTestRetries, fallback.maxTestRetries),
    timeoutMs: normalizePositiveInt(record.timeoutMs, fallback.timeoutMs),
    testFilePatterns: normalizeStringArray(record.testFilePatterns, fallback.testFilePatterns),
    uiChangePatterns: normalizeStringArray(record.uiChangePatterns, fallback.uiChangePatterns),
    uiTestCommandPatterns: normalizeStringArray(
      record.uiTestCommandPatterns,
      fallback.uiTestCommandPatterns,
    ),
    approvalThreshold: normalizeThreshold(record.approvalThreshold, fallback.approvalThreshold),
  };
}

function resolveTesterConfigPath(orchestraceDir: string): string {
  return join(orchestraceDir, TESTER_CONFIG_DIRNAME, TESTER_CONFIG_FILENAME);
}

function normalizeCategories(value: unknown, fallback: TesterCategory[]): TesterCategory[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const allowed = new Set<TesterCategory>(['unit', 'integration', 'api', 'ui', 'deployment']);
  const categories = value
    .filter((entry): entry is TesterCategory => typeof entry === 'string' && allowed.has(entry as TesterCategory));

  return categories.length > 0 ? categories : [...fallback];
}

function normalizeReasoning(value: unknown): TesterReasoningLevel | undefined {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return items.length > 0 ? items : [...fallback];
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeMinUiScreenshotCount(value: unknown, fallback: number): number {
  const resolved = normalizePositiveInt(value, fallback);
  return Math.max(1, resolved);
}

function normalizeThreshold(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.min(1, Math.max(0, parsed));
    }
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
