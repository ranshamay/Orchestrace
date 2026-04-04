import docsUpdate from './docs-update.json';
import fixFailingTest from './fix-failing-test.json';
import safeRefactor from './safe-refactor.json';
import type { EvalCase } from '../types.js';

export const defaultEvalCases: EvalCase[] = [
  fixFailingTest as EvalCase,
  safeRefactor as EvalCase,
  docsUpdate as EvalCase,
];
