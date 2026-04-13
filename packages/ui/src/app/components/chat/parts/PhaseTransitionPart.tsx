import type { PhaseTransitionMessagePart } from '../../../chat-types';
import { PHASE_ICON } from '../../../chat-types';

type Props = { part: PhaseTransitionMessagePart; model?: string };

export function PhaseTransitionPart({ part, model }: Props) {
  const icon = PHASE_ICON[part.phase] ?? '📋';

  return (
    <div className="flex items-center gap-2 py-1.5 my-1">
      <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
      <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1">
        <span>{icon}</span>
        <span>{part.label}</span>
        {model && <span className="font-normal text-slate-400 dark:text-slate-500">· {model}</span>}
      </span>
      <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
    </div>
  );
}
