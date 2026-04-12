import type { ChatContentPart } from '../../lib/api';
import type { ComposerImageAttachment, ComposerMode } from '../types';

export function sanitizeAttachmentName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return 'pasted-image.png';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export function attachmentMarkdown(attachments: ComposerImageAttachment[]): string {
  if (attachments.length === 0) {
    return '';
  }

  const names = attachments
    .map((attachment, index) => sanitizeAttachmentName(attachment.name || `pasted-image-${index + 1}.png`))
    .join(', ');
  return `[attached ${attachments.length} image${attachments.length === 1 ? '' : 's'}: ${names}]`;
}

export function composePrompt(text: string, attachments: ComposerImageAttachment[]): string {
  const base = text.trim();
  if (attachments.length === 0) {
    return base;
  }

  const images = attachmentMarkdown(attachments);
  if (!base) {
    return images;
  }
  return `${base}\n\n${images}`;
}

export function composeRunPromptWithContext(originalPrompt: string, followUpPrompt: string): string {
  const base = originalPrompt.trim();
  const followUp = followUpPrompt.trim();
  if (!base) {
    return followUp;
  }
  if (!followUp) {
    return base;
  }

  return `${base}\n\nFollow-up request:\n${followUp}`;
}

function dataUrlToImagePart(dataUrl: string): { data: string; mimeType: string } | undefined {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }
  return { mimeType: match[1], data: match[2] };
}

export function toComposerContentParts(text: string, attachments: ComposerImageAttachment[]): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: 'text', text: trimmed });
  }

  for (const attachment of attachments) {
    const parsed = dataUrlToImagePart(attachment.dataUrl);
    if (!parsed) {
      continue;
    }

    parts.push({ type: 'image', data: parsed.data, mimeType: parsed.mimeType, name: attachment.name });
  }

  return parts;
}

export function composerModeBadgeClass(mode: ComposerMode): string {
  switch (mode) {
    case 'chat':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300';
    case 'planning':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'implementation':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    default:
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
}

export function composerModeDescription(mode: ComposerMode): string {
  switch (mode) {
    case 'chat':
      return 'Conversational mode for clarification and context.';
    case 'planning':
      return 'Planning mode for architecture and execution plans.';
    case 'implementation':
      return 'Implementation mode with edit-capable tools.';
    default:
      return 'Start a new run (plan + implement).';
  }
}