import { useCallback, useEffect, useState } from 'react';
import type { WorkSession } from '../../lib/api';

type Params = {
  selectedSessionId: string;
  sessions: WorkSession[];
  setSelectedSessionId: (id: string) => void;
};

export function useSessionSelectionController({ selectedSessionId, sessions, setSelectedSessionId }: Params) {
  const [draftRequested, setDraftRequested] = useState(false);

  const setSessionSelection = useCallback((id: string) => {
    setDraftRequested(!id);
    setSelectedSessionId(id);
  }, [setSelectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0 && !draftRequested) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [draftRequested, selectedSessionId, sessions, setSelectedSessionId]);

  return {
    isDraftSession: draftRequested && !selectedSessionId,
    setSessionSelection,
  };
}