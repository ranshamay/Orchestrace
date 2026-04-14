import { describe, expect, it, vi } from "vitest";
import {
  handleHotkeyEvent,
  matchesHotkey,
  registerHotkeys,
  type HotkeyConfig,
} from "../src/app/hooks/useHotkeys";

function makeKeyEvent(
  overrides: Partial<Parameters<typeof handleHotkeyEvent>[0]> = {},
) {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("useHotkeys helpers", () => {
  it("matches Cmd+K and Ctrl+K", () => {
    expect(
      matchesHotkey(makeKeyEvent({ metaKey: true }), {
        key: "k",
        metaKey: true,
        onTrigger: () => undefined,
      }),
    ).toBe(true);

    expect(
      matchesHotkey(makeKeyEvent({ ctrlKey: true }), {
        key: "k",
        ctrlKey: true,
        onTrigger: () => undefined,
      }),
    ).toBe(true);
  });

  it("ignores plain K when modifier is required", () => {
    expect(
      matchesHotkey(makeKeyEvent(), {
        key: "k",
        metaKey: true,
        onTrigger: () => undefined,
      }),
    ).toBe(false);
  });

  it("prevents default and triggers matching shortcut", () => {
    const onTrigger = vi.fn();
    const event = makeKeyEvent({ metaKey: true });

    const hotkeys: HotkeyConfig[] = [{ key: "k", metaKey: true, onTrigger }];

    handleHotkeyEvent(event, hotkeys);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("registerHotkeys installs and removes listener on cleanup", () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    const target = {
      addEventListener: vi.fn(
        (name: string, listener: (event: KeyboardEvent) => void) => {
          listeners.set(name, listener);
        },
      ),
      removeEventListener: vi.fn(
        (name: string, listener: (event: KeyboardEvent) => void) => {
          if (listeners.get(name) === listener) {
            listeners.delete(name);
          }
        },
      ),
    };

    const cleanup = registerHotkeys(target as unknown as Window, [
      { key: "k", ctrlKey: true, onTrigger: vi.fn() },
    ]);

    expect(target.addEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
    expect(listeners.has("keydown")).toBe(true);

    cleanup();

    expect(target.removeEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
    expect(listeners.has("keydown")).toBe(false);
  });
});
