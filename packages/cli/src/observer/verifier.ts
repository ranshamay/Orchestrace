import { readFile, readdir } from 'node:fs/promises';
import { basename as pathBasename, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { LlmAdapter } from '@orchestrace/provider';
import type { FindingRecord, ObserverConfig, VerifiedEvidence } from './types.js';

const VERIFIER_SYSTEM_PROMPT = `You are a code verification agent.
You receive a hypothesis about a bug or code issue plus the current source code.
Determine whether the issue ACTUALLY EXISTS in the provided code right now.

Rules:
- If the code already handles the case, set verified=false.
- If the hypothesis does not match the code, set verified=false.
- Set verified=true only when you can point to specific code snippets.
- Keep evidence concrete and implementation-ready.

Return ONLY valid JSON in this format:
{
  "verified": true,
  "reason": "short explanation",
  "evidence": [
    {
      "file": "path/to/file.ts",
      "currentCode": "code snippet",
      "problem": "what is wrong",
      "suggestedChange": "precise change"
    }
  ]
}`;

const FILE_CHAR_LIMIT = 12_000;
const FILE_COUNT_LIMIT = 5;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.orchestrace', '.turbo']);

export interface VerificationResult {
  verified: boolean;
  reason: string;
  evidence: VerifiedEvidence[];
}

interface VerifyFindingOptions {
  finding: FindingRecord;
  llm: LlmAdapter;
  config: ObserverConfig;
  workspaceRoot: string;
  resolveApiKey: (provider: string) => Promise<string | undefined>;
  signal?: AbortSignal;
}

export async function verifyFindingAgainstCode(options: VerifyFindingOptions): Promise<VerificationResult> {
  const candidates = collectCandidateFiles(options.finding);
  const fileSnippets = await readCandidateSnippets(candidates, options.workspaceRoot);

  if (fileSnippets.length === 0) {
    return {
      verified: false,
      reason: 'No readable file context was available for verification.',
      evidence: [],
    };
  }

  const prompt = buildVerifierPrompt(options.finding, fileSnippets);

  try {
    const apiKey = await options.resolveApiKey(options.config.provider);
    const response = await options.llm.complete({
      provider: options.config.provider,
      model: options.config.model,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      prompt,
      signal: options.signal,
      apiKey,
      refreshApiKey: () => options.resolveApiKey(options.config.provider),
      allowAuthRefreshRetry: true,
    });

    return parseVerifierResponse(response.text, options.finding, fileSnippets);
  } catch (error) {
    return {
      verified: false,
      reason: `Verifier request failed: ${toErrorMessage(error)}`,
      evidence: [],
    };
  }
}

function collectCandidateFiles(finding: FindingRecord): string[] {
  const directPaths = finding.relevantFiles ?? [];
  const extracted = extractPathsFromText([
    finding.title,
    finding.description,
    ...finding.evidence.map((entry) => entry.text),
  ]);

  const deduped = new Set<string>();
  for (const value of [...directPaths, ...extracted]) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    deduped.add(trimmed);
    if (deduped.size >= FILE_COUNT_LIMIT) {
      break;
    }
  }

  return [...deduped];
}

async function readCandidateSnippets(paths: string[], workspaceRoot: string): Promise<Array<{ path: string; content: string }>> {
  const snippets: Array<{ path: string; content: string }> = [];
  const failedPaths: string[] = [];

  for (const rawPath of paths) {
    const safePath = resolveSafePath(workspaceRoot, rawPath);
    if (!safePath) {
      failedPaths.push(rawPath);
      continue;
    }

    try {
      const content = await readFile(safePath.absolute, 'utf-8');
      snippets.push({
        path: safePath.relative,
        content: content.slice(0, FILE_CHAR_LIMIT),
      });
    } catch {
      failedPaths.push(rawPath);
    }
  }

  if (failedPaths.length > 0 && snippets.length < FILE_COUNT_LIMIT) {
    const fileIndex = await listWorkspaceFiles(workspaceRoot);

    for (const rawPath of failedPaths) {
      if (snippets.length >= FILE_COUNT_LIMIT) {
        break;
      }

      const name = pathBasename(rawPath);
      if (!name || !name.includes('.')) {
        continue;
      }

      const match = fileIndex.find((f) => f === name || f.endsWith(`/${name}`));
      if (!match) {
        continue;
      }

      const safePath = resolveSafePath(workspaceRoot, match);
      if (!safePath) {
        continue;
      }

      try {
        const content = await readFile(safePath.absolute, 'utf-8');
        snippets.push({
          path: safePath.relative,
          content: content.slice(0, FILE_CHAR_LIMIT),
        });
      } catch {
        // Skip unreadable candidates.
      }
    }
  }

  return snippets;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name));
        }
      } else {
        const rel = normalize(join(dir, entry.name)).slice(root.length + 1);
        files.push(rel);
      }
    }
  }

  await walk(root);
  return files;
}

function resolveSafePath(workspaceRoot: string, rawPath: string): { absolute: string; relative: string } | null {
  const normalizedRoot = normalize(resolve(workspaceRoot));
  const absoluteCandidate = normalize(
    isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(workspaceRoot, rawPath),
  );

  if (!(absoluteCandidate === normalizedRoot || absoluteCandidate.startsWith(`${normalizedRoot}${sep}`))) {
    return null;
  }

  const relative = absoluteCandidate.slice(normalizedRoot.length + 1);
  return {
    absolute: absoluteCandidate,
    relative,
  };
}

function buildVerifierPrompt(
  finding: FindingRecord,
  snippets: Array<{ path: string; content: string }>,
): string {
  const sections: string[] = [];
  sections.push('## Hypothesis');
  sections.push(`Title: ${finding.title}`);
  sections.push(`Description: ${finding.description}`);
  sections.push('Evidence from observer logs:');
  for (const entry of finding.evidence) {
    sections.push(`- ${entry.text}`);
  }
  sections.push('');
  sections.push('## Current Source Code');

  for (const snippet of snippets) {
    sections.push(`### ${snippet.path}`);
    sections.push('```');
    sections.push(snippet.content);
    sections.push('```');
    sections.push('');
  }

  sections.push('Respond with JSON only.');
  return sections.join('\n');
}

function parseVerifierResponse(
  text: string,
  finding: FindingRecord,
  snippets: Array<{ path: string; content: string }>,
): VerificationResult {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return {
      verified: false,
      reason: 'Verifier returned invalid JSON.',
      evidence: [],
    };
  }

  const verified = parsed.verified === true;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : (verified
      ? 'Verifier confirmed issue exists.'
      : 'Verifier concluded issue is not present in current code.');

  const evidence = normalizeVerifiedEvidence(parsed.evidence);
  if (!verified) {
    return { verified: false, reason, evidence: [] };
  }

  if (evidence.length > 0) {
    return { verified: true, reason, evidence };
  }

  const fallbackSnippet = snippets[0];
  if (!fallbackSnippet) {
    return { verified: false, reason: 'Verifier confirmed issue but provided no evidence.', evidence: [] };
  }

  return {
    verified: true,
    reason,
    evidence: [
      {
        file: fallbackSnippet.path,
        currentCode: fallbackSnippet.content,
        problem: finding.description,
        suggestedChange: finding.evidence.map((entry) => entry.text).join(' '),
      },
    ],
  };
}

function normalizeVerifiedEvidence(value: unknown): VerifiedEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      file: typeof entry.file === 'string' ? entry.file.trim() : '',
      currentCode: typeof entry.currentCode === 'string' ? entry.currentCode.trim() : '',
      problem: typeof entry.problem === 'string' ? entry.problem.trim() : '',
      suggestedChange: typeof entry.suggestedChange === 'string' ? entry.suggestedChange.trim() : '',
    }))
    .filter((entry) =>
      entry.file.length > 0
      && entry.currentCode.length > 0
      && entry.problem.length > 0
      && entry.suggestedChange.length > 0,
    );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractPathsFromText(lines: string[]): string[] {
  const results: string[] = [];
  const pathPattern = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;

  for (const line of lines) {
    const matches = line.match(pathPattern);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      results.push(match);
      if (results.length >= FILE_COUNT_LIMIT) {
        return results;
      }
    }
  }

  return results;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
