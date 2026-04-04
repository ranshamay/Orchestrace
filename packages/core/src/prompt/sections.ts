export const PromptSectionName = {
  Identity: 'identity',
  AutonomyContract: 'autonomy_contract',
  PhaseRules: 'phase_rules',
  SessionContext: 'session_context',
  ExecutionContext: 'execution_context',
  Goal: 'goal',
  Autonomy: 'autonomy',
  OutputContract: 'output_contract',
  TaskContext: 'task_context',
  ApprovedPlan: 'approved_plan',
  DependencyContext: 'dependency_context',
  RetryContext: 'retry_context',
} as const;

export type PromptSectionNameType = (typeof PromptSectionName)[keyof typeof PromptSectionName];

export type PromptSection = {
  name: PromptSectionNameType;
  lines: string[];
};

export function renderPromptSections(sections: PromptSection[]): string {
  return sections
    .map((section) => {
      const body = section.lines
        .map((line) => line.trimEnd())
        .join('\n')
        .trim();

      return [`[section:${section.name}]`, body || '(empty)', `[endsection:${section.name}]`].join('\n');
    })
    .join('\n\n');
}
