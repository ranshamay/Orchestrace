import type { ObserverFindingMessagePart } from '../../../chat-types';

type Props = { part: ObserverFindingMessagePart };

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'text-red-600 dark:text-red-400',
  high: 'text-orange-600 dark:text-orange-400',
  medium: 'text-amber-600 dark:text-amber-400',
  low: 'text-slate-500 dark:text-slate-400',
};

export function ObserverFindingPart({ part }: Props) {
  const sevStyle = SEVERITY_STYLE[part.severity] ?? SEVERITY_STYLE.low;

  return (
    <div className="flex items-start gap-1 text-[11px] py-0.5">
      <span>👁️</span>
      <span className={`font-medium ${sevStyle}`}>[{part.severity}]</span>
      <span className="text-slate-700 dark:text-slate-300">{part.title}</span>
    </div>
  );
}
