import type { ChatMessage, MessagePart } from '../../chat-types';
import { ROLE_ICON, PHASE_ICON } from '../../chat-types';
import { ReasoningPart } from './parts/ReasoningPart';
import { TextPart } from './parts/TextPart';
import { ToolCallPart } from './parts/ToolCallPart';
import { PhaseTransitionPart } from './parts/PhaseTransitionPart';
import { ContextSnapshotPart } from './parts/ContextSnapshotPart';
import { ApprovalRequestPart } from './parts/ApprovalRequestPart';
import { ObserverFindingPart } from './parts/ObserverFindingPart';
import { ErrorPart } from './parts/ErrorPart';

type Props = {
  message: ChatMessage;
  isActive: boolean;
  onApprovePlan: () => Promise<void>;
  onRejectPlan: () => Promise<void>;
};

export function MessageBubble({ message, isActive: _isActive, onApprovePlan, onRejectPlan }: Props) {
  // Phase transition messages render as plain dividers
  if (message.role === 'system' && message.parts.length === 1 && message.parts[0].type === 'phase-transition') {
    return <PhaseTransitionPart part={message.parts[0]} model={message.metadata?.model} />;
  }

  const roleIcon = ROLE_ICON[message.role] ?? '🤖';
  const phaseIcon = message.phase ? PHASE_ICON[message.phase] : '';

  return (
    <div className={`group relative ${message.role === 'user' ? 'pl-8' : ''}`}>
      {/* Role + Phase badge */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className="text-xs" title={message.role}>{roleIcon}</span>
        {phaseIcon && <span className="text-[10px]">{phaseIcon}</span>}
        {message.agentId && (
          <span className="text-[9px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {message.agentId}
          </span>
        )}
        {message.metadata?.model && (
          <span className="text-[9px] text-slate-400 dark:text-slate-500">
            · {message.metadata.model}
          </span>
        )}
      </div>

      {/* Parts */}
      <div className="space-y-0.5">
        {message.parts.map((part, i) => (
          <PartRenderer key={partKey(part, i)} part={part} onApprovePlan={onApprovePlan} onRejectPlan={onRejectPlan} />
        ))}
      </div>
    </div>
  );
}

function PartRenderer({ part, onApprovePlan, onRejectPlan }: { part: MessagePart; onApprovePlan: () => Promise<void>; onRejectPlan: () => Promise<void> }) {
  switch (part.type) {
    case 'reasoning':
      return <ReasoningPart part={part} />;
    case 'text':
      return <TextPart part={part} />;
    case 'tool-call':
      return <ToolCallPart part={part} />;
    case 'phase-transition':
      return <PhaseTransitionPart part={part} />;
    case 'context-snapshot':
      return <ContextSnapshotPart part={part} />;
    case 'approval-request':
      return <ApprovalRequestPart part={part} onApprove={onApprovePlan} onReject={onRejectPlan} />;
    case 'observer-finding':
      return <ObserverFindingPart part={part} />;
    case 'error':
      return <ErrorPart part={part} />;
    default:
      return null;
  }
}

function partKey(part: MessagePart, index: number): string {
  if ('id' in part && part.id) return part.id;
  if (part.type === 'phase-transition') return `pt-${part.phase}-${index}`;
  return `${part.type}-${index}`;
}
