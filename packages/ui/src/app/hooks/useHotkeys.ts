import { useEffect } from "react";

type KeyboardEventLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "preventDefault"
>;

export type HotkeyConfig = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault?: boolean;
  onTrigger: () => void;
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function matchesHotkey(
  event: KeyboardEventLike,
  hotkey: HotkeyConfig,
): boolean {
  if (normalizeKey(event.key) !== normalizeKey(hotkey.key)) {
    return false;
  }

  if (typeof hotkey.metaKey === "boolean" && event.metaKey !== hotkey.metaKey) {
    return false;
  }

  if (typeof hotkey.ctrlKey === "boolean" && event.ctrlKey !== hotkey.ctrlKey) {
    return false;
  }

  if (typeof hotkey.altKey === "boolean" && event.altKey !== hotkey.altKey) {
    return false;
  }

  if (
    typeof hotkey.shiftKey === "boolean" &&
    event.shiftKey !== hotkey.shiftKey
  ) {
    return false;
  }

  return true;
}

export function handleHotkeyEvent(
  event: KeyboardEventLike,
  hotkeys: HotkeyConfig[],
): void {
  for (const hotkey of hotkeys) {
    if (!matchesHotkey(event, hotkey)) {
      continue;
    }

    if (hotkey.preventDefault !== false) {
      event.preventDefault();
    }

    hotkey.onTrigger();
    return;
  }
}

export function registerHotkeys(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  hotkeys: HotkeyConfig[],
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    handleHotkeyEvent(event, hotkeys);
  };

  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
  };
}

export function useHotkeys(hotkeys: HotkeyConfig[]): void {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    return registerHotkeys(window, hotkeys);
  }, [hotkeys]);
}
