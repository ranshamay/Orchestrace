import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultEvalCases, evaluateSuite, type EvalRunRecord } from './index.js';

interface CliOptions {
  resultsPath?: string;
  outPath?: string;
  minPassRate: number;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));

  if (!options.resultsPath) {
    console.error('Usage: pnpm --filter @orchestrace/evals run --results <run-records.json> [--out <summary.json>] [--min-pass-rate 0.8]');
    process.exit(1);
  }

  const resolvedResultsPath = await resolveInputPath(options.resultsPath);
  const runRecords = await loadRunRecords(resolvedResultsPath);
  const summary = evaluateSuite(defaultEvalCases, runRecords);

  printSummary(summary);

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

async function loadRunRecords(path: string): Promise<EvalRunRecord[]> {
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`Expected array of run records in ${path}`);
  }

  return data as EvalRunRecord[];
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
  const parsedMin = Number.parseFloat(minPassRateRaw);

  return {
    resultsPath: getFlagValue(args, '--results'),
    outPath: getFlagValue(args, '--out'),
    minPassRate: Number.isNaN(parsedMin) ? 0.8 : Math.min(1, Math.max(0, parsedMin)),
  };
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }

  return args[idx + 1];
}

function printSummary(summary: ReturnType<typeof evaluateSuite>): void {
  console.log(`\nEval Summary (${summary.generatedAt})`);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
