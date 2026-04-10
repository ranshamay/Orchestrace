export const OBSERVER_FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

type ObserverFindingSeverity = (typeof OBSERVER_FINDING_SEVERITIES)[number];

export interface ObserverFindingsSchemaRenderOptions<TCategory extends string> {
  categories: readonly TCategory[];
  includeLogSnippet?: boolean;
  requiredFields?: readonly string[];
}

export type ObserverFindingsCategoryValidationMode<TCategory extends string> =
  | {
      type: 'coerce';
      fallback: TCategory;
    }
  | {
      type: 'filter';
    };

export interface ObserverFindingParseResult<TCategory extends string> {
  findings: Array<ParsedObserverFinding<TCategory>>;
}

export interface ParsedObserverFinding<TCategory extends string> {
  category: TCategory;
  severity: ObserverFindingSeverity;
  title: string;
  description: string;
  suggestedFix: string;
  relevantFiles?: string[];
  logSnippet?: string;
}

export function stripJsonMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1]?.trim() ?? '';
  }
  return trimmed;
}

export function buildObserverFindingsJsonSchemaBlock<TCategory extends string>(
  options: ObserverFindingsSchemaRenderOptions<TCategory>,
): string {
  const requiredFields =
    options.requiredFields ?? ['category', 'severity', 'title', 'description', 'suggestedFix'];
  const categoryUnion = options.categories.join('|');

  const findingSchemaLines = [
    '      "category": "' + categoryUnion + '",',
    '      "severity": "' + OBSERVER_FINDING_SEVERITIES.join('|') + '",',
    '      "title": "Short one-line title",',
    '      "description": "Detailed description of the issue with context",',
    '      "suggestedFix": "Concrete fix — specific code/config change or action",',
    options.includeLogSnippet
      ? '      "relevantFiles": ["path/to/file.ts"],'
      : '      "relevantFiles": ["path/to/file.ts"]',
  ];

  if (options.includeLogSnippet) {
    findingSchemaLines.push('      "logSnippet": "The 1-3 key log lines that evidence this issue"');
  }

  const lines = ['{', '  "findings": [', '    {', ...findingSchemaLines, '    }', '  ]', '}'];

  return (
    '```json\n' +
    lines.join('\n') +
    '\n```\n' +
    `Required fields per finding: ${requiredFields.join(', ')}.`
  );
}

export function parseObserverFindingsResponse<TCategory extends string>(
  text: string,
  options: {
    categories: readonly TCategory[];
    categoryValidation: ObserverFindingsCategoryValidationMode<TCategory>;
    defaultSeverity?: ObserverFindingSeverity;
    includeLogSnippet?: boolean;
  },
): ObserverFindingParseResult<TCategory> {
  const jsonStr = stripJsonMarkdownFences(text);
  const defaultSeverity = options.defaultSeverity ?? 'medium';

  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const rawFindings = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.findings)
        ? parsed.findings
        : [];

    const findings = rawFindings
      .filter(isRecord)
      .filter(
        (f) =>
          typeof f.title === 'string' &&
          typeof f.description === 'string' &&
          typeof f.suggestedFix === 'string',
      )
      .map((f) => {
        const category = normalizeCategory(f.category, options.categories, options.categoryValidation);
        const severity = normalizeSeverity(f.severity, defaultSeverity);

        if (!category) {
          return null;
        }

        const mapped: ParsedObserverFinding<TCategory> = {
          category,
          severity,
          title: String(f.title),
          description: String(f.description),
          suggestedFix: String(f.suggestedFix),
          relevantFiles: Array.isArray(f.relevantFiles)
            ? f.relevantFiles.filter((p): p is string => typeof p === 'string')
            : undefined,
        };

        if (options.includeLogSnippet) {
          mapped.logSnippet = typeof f.logSnippet === 'string' ? f.logSnippet : '';
        }

        return mapped;
      })
      .filter((f): f is ParsedObserverFinding<TCategory> => f !== null);

    return { findings };
  } catch {
    return { findings: [] };
  }
}

function normalizeSeverity(value: unknown, fallback: ObserverFindingSeverity): ObserverFindingSeverity {
  return typeof value === 'string' &&
    (OBSERVER_FINDING_SEVERITIES as readonly string[]).includes(value)
    ? (value as ObserverFindingSeverity)
    : fallback;
}

function normalizeCategory<TCategory extends string>(
  value: unknown,
  categories: readonly TCategory[],
  mode: ObserverFindingsCategoryValidationMode<TCategory>,
): TCategory | null {
  if (typeof value === 'string' && categories.includes(value as TCategory)) {
    return value as TCategory;
  }

  if (mode.type === 'coerce') {
    return mode.fallback;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}