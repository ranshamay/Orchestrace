type ResizeHandleProps = {
  id: string;
  ariaLabel: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  hiddenOnMobileClassName?: string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
};

export function ResizeHandle({
  id,
  ariaLabel,
  valueNow,
  valueMin,
  valueMax,
  hiddenOnMobileClassName = 'hidden md:block',
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
}: ResizeHandleProps) {
  return (
    <div
      aria-controls={id}
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={valueMax}
      aria-valuemin={valueMin}
      aria-valuenow={Math.round(valueNow)}
      className={`relative w-1 shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-blue-500/30 focus-visible:bg-blue-500/30 focus-visible:outline-none ${hiddenOnMobileClassName}`}
      onKeyDown={onKeyDown}
      onLostPointerCapture={onLostPointerCapture}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      tabIndex={0}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-300/80 dark:bg-slate-700/80" />
    </div>
  );
}