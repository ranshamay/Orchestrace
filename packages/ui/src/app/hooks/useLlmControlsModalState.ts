import { useCallback, useEffect, useState } from 'react';

export function useLlmControlsModalState() {
  const [isLlmControlsModalOpen, setIsLlmControlsModalOpen] = useState(false);

  const openLlmControlsModal = useCallback(() => {
    setIsLlmControlsModalOpen(true);
  }, []);

  const closeLlmControlsModal = useCallback(() => {
    setIsLlmControlsModalOpen(false);
  }, []);

  useEffect(() => {
    if (!isLlmControlsModalOpen || typeof window === 'undefined') return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLlmControlsModalOpen(false);
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [isLlmControlsModalOpen]);

  return {
    isLlmControlsModalOpen,
    setIsLlmControlsModalOpen,
    openLlmControlsModal,
    closeLlmControlsModal,
  };
}