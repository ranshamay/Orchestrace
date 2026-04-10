import type { LlmAdapter } from '@orchestrace/provider';
import type { FindingRecord, ObserverConfig } from './types.js';

const GROUPER_SYSTEM_PROMPT = `You are a deduplication agent for observer findings.
Group findings that represent the SAME underlying code issue.

Rules:
- Group only when one fix would resolve both findings.
- Keep related-but-distinct issues separate.
- Prefer stable canonical titles and descriptions.

Return JSON only:
{
  "groups": [
    {
      "canonicalFingerprint": "existing fingerprint from members",
      "canonicalTitle": "canonical title",
      "canonicalDescription": "canonical description",
      "memberFingerprints": ["fp-a", "fp-b"],
      "reason": "why grouped"
    }
  ]
}`;

export interface FindingGroupDecision {
  canonicalFingerprint: string;
  canonicalTitle?: string;
  canonicalDescription?: string;
  memberFingerprints: string[];
  reason: string;
}

interface GroupVerifiedFindingsOptions {
  findings: FindingRecord[];
  llm: LlmAdapter;
  config: ObserverConfig;
  resolveApiKey: (provider: string) => Promise<string | undefined>;
  signal?: AbortSignal;
}

export async function groupVerifiedFindings(options: GroupVerifiedFindingsOptions): Promise<FindingGroupDecision[]> {
  if (options.findings.length === 0) {
    return [];
  }

  if (options.findings.length === 1) {
    const only = options.findings[0];
    return [{
      canonicalFingerprint: only.fingerprint,
      canonicalTitle: only.title,
      canonicalDescription: only.description,
      memberFingerprints: [only.fingerprint],
      reason: 'single-finding-group',
    }];
  }

  const prompt = buildGroupingPrompt(options.findings);

  try {
    const apiKey = await options.resolveApiKey(options.config.provider);
    const response = await options.llm.complete({
      provider: options.config.provider,
      model: options.config.model,
      systemPrompt: GROUPER_SYSTEM_PROMPT,
      prompt,
      signal: options.signal,
      apiKey,
      refreshApiKey: () => options.resolveApiKey(options.config.provider),
      allowAuthRefreshRetry: true,
    });

    const parsed = parseGroupingResponse(response.text, options.findings);
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    // Fall back to deterministic grouping below.
  }

  return deterministicGrouping(options.findings);
}

function buildGroupingPrompt(findings: FindingRecord[]): string {
  const sections: string[] = [];
  sections.push('## Verified Findings');
  findings.forEach((finding, index) => {
    sections.push(`${index + 1}. [fp: ${finding.fingerprint}] ${finding.title}`);
    sections.push(`   Category: ${finding.category} | Severity: ${finding.severity}`);
    sections.push(`   Description: ${finding.description}`);
    if (finding.relevantFiles && finding.relevantFiles.length > 0) {
      sections.push(`   Relevant files: ${finding.relevantFiles.join(', ')}`);
    }
  });
  sections.push('');
  sections.push('Respond with JSON only.');
  return sections.join('\n');
}

function parseGroupingResponse(text: string, findings: FindingRecord[]): FindingGroupDecision[] {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return [];
  }

  const available = new Set(findings.map((finding) => finding.fingerprint));
  const rawGroups = Array.isArray(parsed.groups) ? parsed.groups : [];
  const decisions: FindingGroupDecision[] = [];

  for (const entry of rawGroups) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const members = Array.isArray(record.memberFingerprints)
      ? record.memberFingerprints.filter((value): value is string => typeof value === 'string' && available.has(value))
      : [];
    if (members.length === 0) {
      continue;
    }

    const preferredCanonical = typeof record.canonicalFingerprint === 'string' ? record.canonicalFingerprint : members[0];
    const canonicalFingerprint = members.includes(preferredCanonical) ? preferredCanonical : members[0];

    decisions.push({
      canonicalFingerprint,
      canonicalTitle: typeof record.canonicalTitle === 'string' ? record.canonicalTitle.trim() : undefined,
      canonicalDescription: typeof record.canonicalDescription === 'string' ? record.canonicalDescription.trim() : undefined,
      memberFingerprints: uniqueStrings(members),
      reason: typeof record.reason === 'string' && record.reason.trim().length > 0
        ? record.reason.trim()
        : 'grouped-by-llm',
    });
  }

  if (decisions.length === 0) {
    return [];
  }

  const covered = new Set(decisions.flatMap((decision) => decision.memberFingerprints));
  for (const finding of findings) {
    if (covered.has(finding.fingerprint)) {
      continue;
    }
    decisions.push({
      canonicalFingerprint: finding.fingerprint,
      canonicalTitle: finding.title,
      canonicalDescription: finding.description,
      memberFingerprints: [finding.fingerprint],
      reason: 'ungrouped-preserved',
    });
  }

  return decisions;
}

function deterministicGrouping(findings: FindingRecord[]): FindingGroupDecision[] {
  const grouped = new Map<string, FindingRecord[]>();

  for (const finding of findings) {
    const key = `${finding.category}::${normalizeForKey(finding.title)}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(finding);
    grouped.set(key, bucket);
  }

  const decisions: FindingGroupDecision[] = [];
  for (const bucket of grouped.values()) {
    const canonical = bucket[0];
    decisions.push({
      canonicalFingerprint: canonical.fingerprint,
      canonicalTitle: canonical.title,
      canonicalDescription: canonical.description,
      memberFingerprints: bucket.map((item) => item.fingerprint),
      reason: bucket.length > 1 ? 'grouped-by-normalized-title' : 'single-finding-group',
    });
  }

  return decisions;
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

function normalizeForKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
