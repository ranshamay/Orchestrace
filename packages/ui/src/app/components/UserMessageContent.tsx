import type { ChatContentPart } from '../../lib/api';

export function UserMessageContent({
  content,
  contentParts,
}: {
  content: string;
  contentParts?: ChatContentPart[];
}) {
  if (!contentParts || contentParts.length === 0) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  const textParts = contentParts.filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text');
  const imageParts = contentParts.filter((part): part is Extract<ChatContentPart, { type: 'image' }> => part.type === 'image');

  return (
    <div className="space-y-2">
      {textParts.length > 0 && (
        <div className="whitespace-pre-wrap break-words">{textParts.map((part) => part.text).join('\n\n')}</div>
      )}
      {imageParts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageParts.map((part, index) => (
            <a
              key={`${part.name ?? 'image'}-${index}`}
              className="block overflow-hidden rounded border border-blue-200 bg-white dark:border-blue-800 dark:bg-slate-900"
              href={`data:${part.mimeType};base64,${part.data}`}
              rel="noreferrer"
              target="_blank"
            >
              <img
                alt={part.name ?? `image-${index + 1}`}
                className="h-24 w-24 object-cover"
                src={`data:${part.mimeType};base64,${part.data}`}
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}