import { useCallback, useEffect, useRef, useState } from 'react';

type Direction = 'normal' | 'reverse';

type UseHorizontalResizeOptions = {
  initialSize: number;
  minSize: number;
  maxSize: number;
  direction?: Direction;
  keyboardStep?: number;
  keyboardLargeStep?: number;
};

type PointerTarget = HTMLElement;

const RESIZE_BODY_CLASS = 'is-horizontal-resizing';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function useHorizontalResize({
  initialSize,
  minSize,
  maxSize,
  direction = 'normal',
  keyboardStep = 16,
  keyboardLargeStep = 40,
}: UseHorizontalResizeOptions) {
  const [size, setSizeState] = useState(() => clamp(initialSize, minSize, maxSize));
  const [isResizing, setIsResizing] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startSizeRef = useRef(0);

  const setSize = useCallback(
    (value: number) => {
      setSizeState(clamp(value, minSize, maxSize));
    },
    [maxSize, minSize],
  );

  const stopResizing = useCallback(() => {
    setIsResizing(false);
    pointerIdRef.current = null;
    if (typeof document !== 'undefined') {
      document.body.classList.remove(RESIZE_BODY_CLASS);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.classList.remove(RESIZE_BODY_CLASS);
      }
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<PointerTarget>) => {
      pointerIdRef.current = event.pointerId;
      startXRef.current = event.clientX;
      startSizeRef.current = size;
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsResizing(true);
      if (typeof document !== 'undefined') {
        document.body.classList.add(RESIZE_BODY_CLASS);
      }
    },
    [size],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<PointerTarget>) => {
      if (!isResizing || pointerIdRef.current !== event.pointerId) return;
      const delta = event.clientX - startXRef.current;
      const signedDelta = direction === 'reverse' ? -delta : delta;
      setSize(startSizeRef.current + signedDelta);
    },
    [direction, isResizing, setSize],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<PointerTarget>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResizing();
    },
    [stopResizing],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<PointerTarget>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResizing();
    },
    [stopResizing],
  );

  const handleLostPointerCapture = useCallback(() => {
    if (!isResizing) return;
    stopResizing();
  }, [isResizing, stopResizing]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<PointerTarget>) => {
      const step = event.shiftKey ? keyboardLargeStep : keyboardStep;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const signedStep = direction === 'reverse' ? step : -step;
        setSize(size + signedStep);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const signedStep = direction === 'reverse' ? -step : step;
        setSize(size + signedStep);
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        setSize(minSize);
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        setSize(maxSize);
      }
    },
    [direction, keyboardLargeStep, keyboardStep, maxSize, minSize, setSize, size],
  );

  return {
    size,
    setSize,
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleLostPointerCapture,
    handleKeyDown,
    minSize,
    maxSize,
  };
}