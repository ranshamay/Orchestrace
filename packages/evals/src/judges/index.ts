import { globMatches, median } from './common.js';
import type { EvalCase, EvalCaseResult, EvalRunRecord, EvalSummary } from '../types.js';

export function evaluateCase(evalCase: EvalCase, runRecord: EvalRunRecord | undefined): EvalCaseResult {
  const reasons: string[] = [];

  if (!runRecord) {
    reasons.push('Missing run record for case.');
    return {
      caseId: evalCase.id,
      pass: false,
      reasons,
      attempts: 0,
      usage: { input: 0, output: 0, cost: 0 },
    };
  }

  const attempts = runRecord.retries + 1;
  const usage = runRecord.usage ?? { input: 0, output: 0, cost: 0 };

  if (runRecord.status !== evalCase.expectation.requiredStatus) {
    reasons.push(
      `Expected status ${evalCase.expectation.requiredStatus} but received ${runRecord.status}.`,
    );
  }

  if (typeof evalCase.expectation.maxAttempts === 'number' && attempts > evalCase.expectation.maxAttempts) {
    reasons.push(`Expected at most ${evalCase.expectation.maxAttempts} attempt(s), got ${attempts}.`);
  }

  if (evalCase.expectation.requireValidationPass && runRecord.validationPassed !== true) {
    reasons.push('Expected validation to pass.');
  }

  if (typeof evalCase.expectation.minOutputTokens === 'number' && usage.output < evalCase.expectation.minOutputTokens) {
    reasons.push(
      `Expected at least ${evalCase.expectation.minOutputTokens} output token(s), got ${usage.output}.`,
    );
  }

  if (evalCase.expectation.allowFileGlobs && runRecord.filesChanged && runRecord.filesChanged.length > 0) {
    const disallowed = runRecord.filesChanged.filter((file) => {
      return !evalCase.expectation.allowFileGlobs?.some((pattern) => globMatches(file, pattern));
    });

    if (disallowed.length > 0) {
      reasons.push(`Disallowed changed files: ${disallowed.join(', ')}`);
    }
  }

  return {
    caseId: evalCase.id,
    pass: reasons.length === 0,
    reasons,
    attempts,
    usage,
  };
}

export function evaluateSuite(cases: EvalCase[], runRecords: EvalRunRecord[]): EvalSummary {
  const byCase = new Map(runRecords.map((record) => [record.caseId, record]));
  const caseResults = cases.map((evalCase) => evaluateCase(evalCase, byCase.get(evalCase.id)));
  const passedCases = caseResults.filter((result) => result.pass).length;

  return {
    generatedAt: new Date().toISOString(),
    totalCases: caseResults.length,
    passedCases,
    failedCases: caseResults.length - passedCases,
    passRate: caseResults.length === 0 ? 0 : passedCases / caseResults.length,
    medianAttempts: median(caseResults.map((result) => result.attempts)),
    totalUsage: caseResults.reduce(
      (acc, result) => ({
        input: acc.input + result.usage.input,
        output: acc.output + result.usage.output,
        cost: acc.cost + result.usage.cost,
      }),
      { input: 0, output: 0, cost: 0 },
    ),
    caseResults,
  };
}
