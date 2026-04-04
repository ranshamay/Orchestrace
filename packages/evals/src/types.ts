export type EvalStatus = 'completed' | 'failed';

export interface EvalCaseExpectation {
  requiredStatus: EvalStatus;
  maxAttempts?: number;
  requireValidationPass?: boolean;
  allowFileGlobs?: string[];
  minOutputTokens?: number;
}

export interface EvalCase {
  id: string;
  name: string;
  description: string;
  prompt: string;
  expectation: EvalCaseExpectation;
}

export interface EvalRunRecord {
  caseId: string;
  status: EvalStatus;
  retries: number;
  filesChanged?: string[];
  usage?: { input: number; output: number; cost: number };
  validationPassed?: boolean;
}

export interface EvalCaseResult {
  caseId: string;
  pass: boolean;
  reasons: string[];
  attempts: number;
  usage: { input: number; output: number; cost: number };
}

export interface EvalSummary {
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  medianAttempts: number;
  totalUsage: { input: number; output: number; cost: number };
  caseResults: EvalCaseResult[];
}
