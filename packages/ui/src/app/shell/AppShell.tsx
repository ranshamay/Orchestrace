import { useMemo } from 'react';
import { AppMainContent } from '../components/AppMainContent';
import { ResizeHandle } from '../components/layout/ResizeHandle';
import { SessionSidebar } from '../components/SessionSidebar';
import { ErrorToast } from '../components/overlays/ErrorToast';
import { LlmControlsModal } from '../components/overlays/LlmControlsModal';
import { useHorizontalResize } from '../hooks/useHorizontalResize';
import type { AppShellProps } from './types';

const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 480;

export function AppShell({ sessionSidebarProps, mainContentProps, llmModalProps, errorMessage }: AppShellProps) {
  const computedSidebarMax = useMemo(() => {
    if (typeof window === 'undefined') return SIDEBAR_MAX_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.4));
  }, []);

  const sidebarResize = useHorizontalResize({
    initialSize: SIDEBAR_DEFAULT_WIDTH,
    minSize: SIDEBAR_MIN_WIDTH,
    maxSize: computedSidebarMax,
    direction: 'reverse',
  });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 md:flex-row">
      <main className="min-w-0 flex-1">
        <AppMainContent {...mainContentProps} />
      </main>
      <ResizeHandle
        ariaLabel="Resize sessions panel"
        hiddenOnMobileClassName="hidden md:block"
        id="session-sidebar"
        onKeyDown={sidebarResize.handleKeyDown}
        onLostPointerCapture={sidebarResize.handleLostPointerCapture}
        onPointerCancel={sidebarResize.handlePointerCancel}
        onPointerDown={sidebarResize.handlePointerDown}
        onPointerMove={sidebarResize.handlePointerMove}
        onPointerUp={sidebarResize.handlePointerUp}
        valueMax={sidebarResize.maxSize}
        valueMin={sidebarResize.minSize}
        valueNow={sidebarResize.size}
      />
      <div
        className="w-full md:shrink-0 md:w-[var(--session-sidebar-width)]"
        id="session-sidebar"
        style={{ '--session-sidebar-width': `${sidebarResize.size}px` } as React.CSSProperties}
      >
        <SessionSidebar {...sessionSidebarProps} />
      </div>
      <ErrorToast message={errorMessage} />
      <LlmControlsModal {...llmModalProps} />
    </div>
  );
}