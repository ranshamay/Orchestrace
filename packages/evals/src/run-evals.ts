import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultEvalCases, evaluateSuite, type EvalCase, type EvalRunRecord } from './index.js';
import { globMatches } from './judges/common.js';

interface CliOptions {
  resultsPath?: string;
  replayDir?: string;
  caseMapPath?: string;
  defaultCaseId?: string;
  caseIds: string[];
  changedFilesPath?: string;
  maxRuns: number;
  outPath?: string;
  minPassRate: number;
}

interface CaseMap {
  taskIds: Record<string, string>;
  graphIds: Record<string, string>;
  runIds: Record<string, string>;
  defaultCaseId?: string;
}

interface ReplayTaskSummary {
  taskId: string;
  file: string;
}

interface ReplayRunIndex {
  createdAt?: string;
  runId: string;
  tasks?: ReplayTaskSummary[];
}

interface ReplayUsage {
  input?: number;
  output?: number;
  cost?: number;
}

interface ReplayValidationResult {
  passed: boolean;
}

interface ReplayToolCall {
  toolName?: string;
  status?: 'started' | 'result';
  input?: string;
}

interface ReplayAttempt {
  phase?: 'planning' | 'implementation';
  validation?: ReplayValidationResult;
  toolCalls?: ReplayToolCall[];
}

interface ReplayTaskArtifact {
  runId?: string;
  graphId?: string;
  taskId?: string;
  status?: string;
  retries?: number;
  usage?: ReplayUsage;
  failureType?: string;
  validationResults?: Array<{ passed?: boolean }>;
  replay?: {
    attempts?: ReplayAttempt[];
  };
}

const DOCS_ONLY_PATTERNS = ['docs/**', 'README.md', 'packages/*/README.md'];

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));

  if (!options.resultsPath && !options.replayDir) {
    console.error(
      'Usage: pnpm --filter @orchestrace/evals run run-evals --results <run-records.json> | --replay-dir <.orchestrace/runs> [--case-map <map.json>] [--default-case <case-id>] [--cases case-a,case-b] [--changed-files <files.txt>] [--max-runs 20] [--out <summary.json>] [--min-pass-rate 0.8]',
    );
    process.exit(1);
  }

    const changedFiles = options.changedFilesPath
    ? await loadChangedFilesSafe(options.changedFilesPath)
    : [];
  const selectedCases = selectEvalCases(defaultEvalCases, options.caseIds, changedFiles);
  if (selectedCases.length === 0) {
    throw new Error('No eval cases selected. Check --cases and --changed-files filters.');
  }

  const selectedCaseIds = new Set(selectedCases.map((evalCase) => evalCase.id));
  const loadedRecords = await loadRecords(options, selectedCases, selectedCaseIds);
  const summary = evaluateSuite(selectedCases, loadedRecords.records);

  printSummary(summary, {
    source: loadedRecords.source,
    selectedCaseIds: selectedCases.map((evalCase) => evalCase.id),
    changedFiles,
  });

  if (options.outPath) {
    const resolvedOutPath = resolveOutputPath(options.outPath);
    await writeFile(resolvedOutPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
    console.log(`\nWrote eval summary: ${resolvedOutPath}`);
  }

  if (summary.passRate < options.minPassRate) {
    console.error(`\nEval gate failed: pass rate ${formatPercent(summary.passRate)} < ${formatPercent(options.minPassRate)}`);
    process.exit(1);
  }
}

async function loadRecords(
  options: CliOptions,
  selectedCases: EvalCase[],
  selectedCaseIds: Set<string>,
): Promise<{ source: string; records: EvalRunRecord[] }> {
  if (options.replayDir) {
    try {
      const resolvedReplayDir = await resolveInputPath(options.replayDir);
      const caseMap = options.caseMapPath
        ? await loadCaseMap(await resolveInputPath(options.caseMapPath))
        : emptyCaseMap();
      const replayRecords = await loadReplayRecords(resolvedReplayDir, {
        selectedCases,
        selectedCaseIds,
        caseMap,
        defaultCaseId: options.defaultCaseId,
        maxRuns: options.maxRuns,
      });

      if (replayRecords.length > 0) {
        return {
          source: `replay:${resolvedReplayDir}`,
          records: replayRecords,
        };
      }

      if (!options.resultsPath) {
        throw new Error(`No replay records were discovered under ${resolvedReplayDir}.`);
      }
    } catch (error) {
      if (!options.resultsPath) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Replay ingestion skipped, falling back to --results: ${reason}`);
    }
  }

  if (!options.resultsPath) {
    throw new Error('No results path was provided.');
  }

  const resolvedResultsPath = await resolveInputPath(options.resultsPath);
  const runRecords = await loadRunRecords(resolvedResultsPath);
  return {
    source: `results:${resolvedResultsPath}`,
    records: runRecords,
  };
}

async function loadRunRecords(path: string): Promise<EvalRunRecord[]> {
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`Expected array of run records in ${path}`);
  }

  return data as EvalRunRecord[];
}

async function loadReplayRecords(
  replayDir: string,
  options: {
    selectedCases: EvalCase[];
    selectedCaseIds: Set<string>;
    caseMap: CaseMap;
    defaultCaseId?: string;
    maxRuns: number;
  },
): Promise<EvalRunRecord[]> {
  const runDirs = await resolveReplayRunDirs(replayDir, options.maxRuns);
  const records: EvalRunRecord[] = [];

  for (const runDir of runDirs) {
    const artifacts = await loadReplayTaskArtifacts(runDir);
    for (const artifact of artifacts) {
      const record = toEvalRunRecord(artifact, {
        selectedCases: options.selectedCases,
        selectedCaseIds: options.selectedCaseIds,
        caseMap: options.caseMap,
        defaultCaseId: options.defaultCaseId,
      });
      if (record) {
        records.push(record);
      }
    }
  }

  return records;
}

async function resolveReplayRunDirs(replayDir: string, maxRuns: number): Promise<string[]> {
  const directIndexPath = resolve(replayDir, 'index.json');
  if (await fileExists(directIndexPath)) {
    return [replayDir];
  }

  const entries = await readdir(replayDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const runDirs: string[] = [];
  for (const runId of candidates) {
    const runDir = resolve(replayDir, runId);
    if (await fileExists(resolve(runDir, 'index.json'))) {
      runDirs.push(runDir);
    }
  }

  if (runDirs.length <= maxRuns) {
    return runDirs;
  }

  return runDirs.slice(runDirs.length - maxRuns);
}

async function loadReplayTaskArtifacts(runDir: string): Promise<ReplayTaskArtifact[]> {
  const indexPath = resolve(runDir, 'index.json');
  const rawIndex = await readFile(indexPath, 'utf-8');
  const index = JSON.parse(rawIndex) as ReplayRunIndex;

  const taskFiles = Array.isArray(index.tasks)
    ? index.tasks.map((task) => task.file)
    : [];

  const filesToRead = taskFiles.length > 0
    ? taskFiles
    : (await readdir(runDir)).filter((name) => name.endsWith('.json') && name !== 'index.json');

  const artifacts: ReplayTaskArtifact[] = [];
  for (const file of filesToRead) {
    const artifactPath = resolve(runDir, file);
    try {
      const raw = await readFile(artifactPath, 'utf-8');
      const parsed = JSON.parse(raw) as ReplayTaskArtifact;
      artifacts.push(parsed);
    } catch {
      continue;
    }
  }

  return artifacts;
}

function toEvalRunRecord(
  artifact: ReplayTaskArtifact,
  options: {
    selectedCases: EvalCase[];
    selectedCaseIds: Set<string>;
    caseMap: CaseMap;
    defaultCaseId?: string;
  },
): EvalRunRecord | undefined {
  const filesChanged = extractFilesChanged(artifact);
  const caseId = resolveCaseId(artifact, options);
  if (!caseId) {
    return undefined;
  }

  const status = artifact.status === 'completed' ? 'completed' : 'failed';
  const retries = asNonNegativeInteger(artifact.retries);
  const usage = normalizeUsage(artifact.usage);

  return {
    caseId,
    status,
    retries,
    filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
    validationPassed: resolveValidationPassed(artifact),
    usage,
  };
}

function resolveCaseId(
  artifact: ReplayTaskArtifact,
  options: {
    selectedCases: EvalCase[];
    selectedCaseIds: Set<string>;
    caseMap: CaseMap;
    defaultCaseId?: string;
  },
): string | undefined {
  const taskId = asString(artifact.taskId);
  const graphId = asString(artifact.graphId);
  const runId = asString(artifact.runId);

  const byDirectMatch = [taskId, graphId, runId].find((value) => {
    if (!value) {
      return false;
    }
    return options.selectedCaseIds.has(value);
  });
  if (byDirectMatch) {
    return byDirectMatch;
  }

  const mapped = [
    taskId ? options.caseMap.taskIds[taskId] : undefined,
    graphId ? options.caseMap.graphIds[graphId] : undefined,
    runId ? options.caseMap.runIds[runId] : undefined,
    options.defaultCaseId,
    options.caseMap.defaultCaseId,
  ].find((value) => typeof value === 'string' && value.length > 0);

  if (mapped && options.selectedCaseIds.has(mapped)) {
    return mapped;
  }

  const inferred = inferCaseIdFromArtifactFiles(artifact, options.selectedCases);
  if (inferred && options.selectedCaseIds.has(inferred)) {
    return inferred;
  }

  if (options.selectedCaseIds.size === 1) {
    return [...options.selectedCaseIds][0];
  }

  return undefined;
}

function inferCaseIdFromArtifactFiles(artifact: ReplayTaskArtifact, selectedCases: EvalCase[]): string | undefined {
  const filesChanged = extractFilesChanged(artifact);
  if (filesChanged.length === 0) {
    return undefined;
  }

  const candidates = selectedCases.filter((evalCase) => {
    const allowed = evalCase.expectation.allowFileGlobs;
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return false;
    }

    return filesChanged.every((filePath) => allowed.some((pattern) => globMatches(filePath, pattern)));
  });

  if (candidates.length === 1) {
    return candidates[0].id;
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  return 0;
}

function normalizeUsage(usage: ReplayUsage | undefined): { input: number; output: number; cost: number } {
  return {
    input: asNonNegativeNumber(usage?.input),
    output: asNonNegativeNumber(usage?.output),
    cost: asNonNegativeNumber(usage?.cost),
  };
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  return 0;
}

function extractFilesChanged(artifact: ReplayTaskArtifact): string[] {
  const fromReplay = new Set<string>();
  const attempts = artifact.replay?.attempts;
  if (!Array.isArray(attempts)) {
    return [];
  }

  for (const attempt of attempts) {
    const toolCalls = attempt.toolCalls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.status !== 'started' || !isMutatingToolName(toolCall.toolName)) {
        continue;
      }

      for (const path of extractPathsFromToolInput(toolCall.input)) {
        fromReplay.add(path);
      }
    }
  }

  return [...fromReplay];
}

function isMutatingToolName(toolName: unknown): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return false;
  }

  return /(write|edit|create|delete|rename|move|replace|apply_patch|insert)/i.test(toolName);
}

function extractPathsFromToolInput(input: unknown): string[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const value = parsed as Record<string, unknown>;
  const candidates = [
    value.path,
    value.filePath,
    value.targetPath,
    value.newPath,
    value.oldPath,
    value.destinationPath,
    value.sourcePath,
    value.paths,
    value.files,
  ];

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        paths.push(normalized);
      }
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string' && item.trim().length > 0) {
          paths.push(item.trim());
        }
      }
    }
  }

  return paths;
}

function resolveValidationPassed(artifact: ReplayTaskArtifact): boolean | undefined {
  const attempts = artifact.replay?.attempts;
  if (Array.isArray(attempts)) {
    for (let idx = attempts.length - 1; idx >= 0; idx -= 1) {
      const attempt = attempts[idx];
      if (attempt.phase !== 'implementation') {
        continue;
      }
      if (attempt.validation && typeof attempt.validation.passed === 'boolean') {
        return attempt.validation.passed;
      }
    }
  }

  const validationResults = artifact.validationResults;
  if (!Array.isArray(validationResults) || validationResults.length === 0) {
    return undefined;
  }

  return validationResults.every((result) => result.passed === true);
}

function selectEvalCases(allCases: EvalCase[], caseIds: string[], changedFiles: string[]): EvalCase[] {
  const byId = new Map(allCases.map((evalCase) => [evalCase.id, evalCase]));

  if (caseIds.length > 0) {
    const selected = caseIds
      .map((id) => byId.get(id))
      .filter((evalCase): evalCase is EvalCase => Boolean(evalCase));
    return selected;
  }

  if (changedFiles.length === 0) {
    return allCases;
  }

  const docsOnly = changedFiles.every((filePath) => {
    return DOCS_ONLY_PATTERNS.some((pattern) => globMatches(filePath, pattern));
  });

  const filtered = allCases.filter((evalCase) => {
    const allowed = evalCase.expectation.allowFileGlobs;
    if (Array.isArray(allowed) && allowed.length > 0) {
      return changedFiles.every((filePath) => allowed.some((pattern) => globMatches(filePath, pattern)));
    }

    return !docsOnly;
  });

  if (filtered.length === 0) {
    return allCases;
  }

  return filtered;
}

async function loadChangedFilesSafe(path: string): Promise<string[]> {
  const resolvedPath = await resolveInputPath(path);

  try {
    return await loadChangedFiles(resolvedPath);
  } catch (error) {
    if (isEnoentError(error)) {
      console.warn(`Changed-files list not found at ${resolvedPath}; continuing without changed-file filtering.`);
      return [];
    }

    throw error;
  }
}

async function loadChangedFiles(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf-8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return trimmed
    .split(/\r?\n|,/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function loadCaseMap(path: string): Promise<CaseMap> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid case map at ${path}. Expected JSON object.`);
  }

  const mapObject = parsed as Record<string, unknown>;
  if (
    Object.values(mapObject).every((value) => typeof value === 'string')
    && !('taskIds' in mapObject)
    && !('graphIds' in mapObject)
    && !('runIds' in mapObject)
  ) {
    return {
      taskIds: objectStringMap(mapObject),
      graphIds: {},
      runIds: {},
      defaultCaseId: undefined,
    };
  }

  return {
    taskIds: objectStringMap(mapObject.taskIds),
    graphIds: objectStringMap(mapObject.graphIds),
    runIds: objectStringMap(mapObject.runIds),
    defaultCaseId: asString(mapObject.defaultCaseId),
  };
}

function objectStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out[key] = entry.trim();
    }
  }

  return out;
}

function emptyCaseMap(): CaseMap {
  return {
    taskIds: {},
    graphIds: {},
    runIds: {},
    defaultCaseId: undefined,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isEnoentError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function resolveInputPath(path: string): Promise<string> {
  const candidates = [
    resolve(process.cwd(), path),
  ];

  const initCwd = process.env.INIT_CWD;
  if (initCwd && initCwd !== process.cwd()) {
    candidates.push(resolve(initCwd, path));
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return candidates[0];
}

function resolveOutputPath(path: string): string {
  const initCwd = process.env.INIT_CWD;
  if (initCwd && initCwd !== process.cwd()) {
    return resolve(initCwd, path);
  }

  return resolve(process.cwd(), path);
}

function parseCli(args: string[]): CliOptions {
  const minPassRateRaw = getFlagValue(args, '--min-pass-rate')
    ?? process.env.ORCHESTRACE_EVAL_MIN_PASS_RATE
    ?? '0.8';
  const maxRunsRaw = getFlagValue(args, '--max-runs')
    ?? process.env.ORCHESTRACE_EVAL_MAX_RUNS
    ?? '20';
  const parsedMin = Number.parseFloat(minPassRateRaw);
  const parsedMaxRuns = Number.parseInt(maxRunsRaw, 10);
  const caseIds = parseListFlag(
    getFlagValue(args, '--cases')
      ?? process.env.ORCHESTRACE_EVAL_CASES,
  );

  return {
    resultsPath: getFlagValue(args, '--results'),
    replayDir: getFlagValue(args, '--replay-dir') ?? process.env.ORCHESTRACE_EVAL_REPLAY_DIR,
    caseMapPath: getFlagValue(args, '--case-map') ?? process.env.ORCHESTRACE_EVAL_CASE_MAP,
    defaultCaseId: getFlagValue(args, '--default-case') ?? process.env.ORCHESTRACE_EVAL_DEFAULT_CASE_ID,
    caseIds,
    changedFilesPath: getFlagValue(args, '--changed-files') ?? process.env.ORCHESTRACE_EVAL_CHANGED_FILES,
    maxRuns: Number.isNaN(parsedMaxRuns) ? 20 : Math.max(1, parsedMaxRuns),
    outPath: getFlagValue(args, '--out'),
    minPassRate: Number.isNaN(parsedMin) ? 0.8 : Math.min(1, Math.max(0, parsedMin)),
  };
}

function parseListFlag(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }

  return args[idx + 1];
}

function printSummary(
  summary: ReturnType<typeof evaluateSuite>,
  context: { source: string; selectedCaseIds: string[]; changedFiles: string[] },
): void {
  console.log(`\nEval Summary (${summary.generatedAt})`);
  console.log(`Source: ${context.source}`);
  console.log(`Selected cases: ${context.selectedCaseIds.join(', ')}`);
  if (context.changedFiles.length > 0) {
    console.log(`Changed files considered: ${context.changedFiles.length}`);
  }
  console.log(`Cases: ${summary.totalCases} | Passed: ${summary.passedCases} | Failed: ${summary.failedCases}`);
  console.log(`Pass rate: ${formatPercent(summary.passRate)} | Median attempts: ${summary.medianAttempts}`);
  console.log(`Usage: in=${summary.totalUsage.input}, out=${summary.totalUsage.output}, cost=$${summary.totalUsage.cost.toFixed(4)}`);

  for (const result of summary.caseResults) {
    const status = result.pass ? 'PASS' : 'FAIL';
    const reasons = result.reasons.length > 0 ? ` (${result.reasons.join(' | ')})` : '';
    console.log(`- ${status} ${result.caseId} attempts=${result.attempts}${reasons}`);
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

if (isDirectExecution()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export {
  extractFilesChanged,
  resolveValidationPassed,
  selectEvalCases,
  toEvalRunRecord,
};
