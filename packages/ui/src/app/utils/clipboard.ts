import type { ComposerImageAttachment } from '../types';

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (copied) {
      return;
    }
  }

  throw new Error('Clipboard is not available in this browser context.');
}

export async function readClipboardImage(item: DataTransferItem): Promise<ComposerImageAttachment | null> {
  const file = item.getAsFile();
  if (!file) {
    return null;
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read pasted image'));
    reader.readAsDataURL(file);
  });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: file.name || 'pasted-image.png',
    mime: file.type || 'image/png',
    dataUrl,
  };
}