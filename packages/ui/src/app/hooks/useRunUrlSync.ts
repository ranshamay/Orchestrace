import { useEffect } from 'react';
import { readRunIdFromUrl, updateRunIdInUrl } from '../utils/runUrl';

export function useRunUrlSync(
  selectedSessionId: string,
  setSelectedSessionId: (id: string) => void,
) {
  useEffect(() => {
    updateRunIdInUrl(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePopState = () => {
      setSelectedSessionId(readRunIdFromUrl());
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [setSelectedSessionId]);
}