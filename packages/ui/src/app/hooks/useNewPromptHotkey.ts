import { useEffect } from 'react';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  return false;
}

export function useNewPromptHotkey(onTrigger: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      if (!hasPrimaryModifier || event.altKey || event.shiftKey || key !== 'k') {
        return;
      }

      event.preventDefault();
      onTrigger();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, onTrigger]);
}