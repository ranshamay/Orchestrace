import { useRef, useState } from 'react';
import { AppMainContent } from '../components/AppMainContent';
import { SessionSidebar } from '../components/SessionSidebar';
import { ErrorToast } from '../components/overlays/ErrorToast';
import { LlmControlsModal } from '../components/overlays/LlmControlsModal';
import type { AppShellProps } from './types';

const SESSION_SIDEBAR_MIN_WIDTH = 220;
const MAIN_CONTENT_MIN_WIDTH = 480;
const RESIZER_WIDTH = 10;
const SESSION_SIDEBAR_DEFAULT_WIDTH = 256;

export function AppShell({
  sessionSidebarProps,
  mainContentProps,
  llmModalProps,
  errorMessage,
  sessionSidebarWidthPx,
  onSetSessionSidebarWidthPx,
}: AppShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  return (
    <div ref={rootRef} className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 md:flex-row">
      <main className="min-w-0 flex-1">
        <AppMainContent {...mainContentProps} />
      </main>

      <button
        aria-label="Resize sessions panel"
        className={`relative hidden shrink-0 touch-none cursor-col-resize border-l border-slate-200 bg-white/70 dark:border-slate-700 dark:bg-slate-900/70 md:block ${isDraggingSidebar ? 'w-2 bg-blue-200/70 dark:bg-blue-700/50' : 'w-px hover:w-2 hover:bg-blue-100/80 dark:hover:bg-blue-900/40'}`}
        onDoubleClick={() => onSetSessionSidebarWidthPx(SESSION_SIDEBAR_DEFAULT_WIDTH)}
        onPointerDown={(event) => {
          if (!rootRef.current) {
            return;
          }
          event.preventDefault();
          const pointerId = event.pointerId;
          const startX = event.clientX;
          const startWidth = sessionSidebarWidthPx;
          const rootWidth = rootRef.current.getBoundingClientRect().width;
          const maxWidth = Math.max(SESSION_SIDEBAR_MIN_WIDTH, rootWidth - MAIN_CONTENT_MIN_WIDTH - RESIZER_WIDTH);
          const handle = event.currentTarget;
          setIsDraggingSidebar(true);
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'col-resize';
          handle.setPointerCapture(pointerId);

          const applyWidth = (next: number) => {
            const clamped = Math.min(maxWidth, Math.max(SESSION_SIDEBAR_MIN_WIDTH, next));
            onSetSessionSidebarWidthPx(clamped);
          };

          const onPointerMove = (moveEvent: PointerEvent) => {
            const deltaX = moveEvent.clientX - startX;
            applyWidth(startWidth + deltaX);
          };

          const cleanup = () => {
            setIsDraggingSidebar(false);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            handle.removeEventListener('pointermove', onPointerMove);
            handle.removeEventListener('pointerup', onPointerUp);
            handle.removeEventListener('pointercancel', onPointerUp);
            try {
              handle.releasePointerCapture(pointerId);
            } catch {
              // pointer capture may already be released
            }
          };

          const onPointerUp = () => {
            cleanup();
          };

          handle.addEventListener('pointermove', onPointerMove);
          handle.addEventListener('pointerup', onPointerUp);
          handle.addEventListener('pointercancel', onPointerUp);
        }}
        type="button"
      />

      <SessionSidebar {...sessionSidebarProps} desktopWidthPx={sessionSidebarWidthPx} />
      <ErrorToast message={errorMessage} />
      <LlmControlsModal {...llmModalProps} />
    </div>
  );
}