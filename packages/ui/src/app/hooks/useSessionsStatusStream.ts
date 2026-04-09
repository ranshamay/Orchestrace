import { useEffect, useRef } from 'react';
import { API_BASE, type WorkSession } from '../../lib/api';
import { sortSessionsByActivityAndRecency } from '../utils/sessionSort';

type Params = {
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  setSessions: (updater: WorkSession[] | ((current: WorkSession[]) => WorkSession[])) => void;
};

/**
 * Keeps the sessions rail synchronized in real time from the server-wide
 * session status stream, independent from the selected session stream.
 */
export function useSessionsStatusStream({ selectedSessionId, setSelectedSessionId, setSessions }: Params) {
  const selectedSessionIdRef = useRef(selectedSessionId);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/work/sessions/stream`);

    const handleReady = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { sessions?: WorkSession[] };
        if (!Array.isArray(data.sessions)) {
          return;
        }

        setSessions(sortSessionsByActivityAndRecency(data.sessions));
      } catch {
        // Ignore malformed stream payloads.
      }
    };

    const handleSessionUpsert = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { session?: WorkSession };
        if (!data.session) {
          return;
        }

        const nextSession = data.session;

        setSessions((current) => {
          const index = current.findIndex((session) => session.id === nextSession.id);
          if (index >= 0) {
            const next = [...current];
            next[index] = nextSession;
            return sortSessionsByActivityAndRecency(next);
          }
          return sortSessionsByActivityAndRecency([nextSession, ...current]);
        });
      } catch {
        // Ignore malformed stream payloads.
      }
    };

    const handleSessionDelete = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { id?: string };
        if (!data.id) {
          return;
        }

        let nextSelectedSessionId: string | null = null;
        setSessions((current) => {
          const next = current.filter((session) => session.id !== data.id);
          if (selectedSessionIdRef.current === data.id) {
            nextSelectedSessionId = next[0]?.id ?? '';
          }
          return next;
        });

        if (nextSelectedSessionId !== null) {
          setSelectedSessionId(nextSelectedSessionId);
        }
      } catch {
        // Ignore malformed stream payloads.
      }
    };

    es.addEventListener('ready', handleReady as EventListener);
    es.addEventListener('session-upsert', handleSessionUpsert as EventListener);
    es.addEventListener('session-delete', handleSessionDelete as EventListener);

    return () => {
      es.close();
    };
  }, [setSelectedSessionId, setSessions]);
}
