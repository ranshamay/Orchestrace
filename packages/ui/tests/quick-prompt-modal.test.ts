import { describe, expect, it } from "vitest";
import {
  canSubmitQuickPrompt,
  normalizeQuickPrompt,
  shouldCloseQuickPrompt,
  shouldSubmitQuickPrompt,
} from "../src/app/components/overlays/quickPromptUtils";

describe("QuickPromptModal helpers", () => {
  it("normalizes input before submit", () => {
    expect(normalizeQuickPrompt("  build a release plan  ")).toBe(
      "build a release plan",
    );
  });

  it("disables submit for empty prompt", () => {
    expect(canSubmitQuickPrompt("")).toBe(false);
    expect(canSubmitQuickPrompt("   ")).toBe(false);
    expect(canSubmitQuickPrompt("ship feature")).toBe(true);
  });

  it("submits on Enter without Shift", () => {
    expect(shouldSubmitQuickPrompt({ key: "Enter", shiftKey: false })).toBe(
      true,
    );
    expect(shouldSubmitQuickPrompt({ key: "Enter", shiftKey: true })).toBe(
      false,
    );
    expect(shouldSubmitQuickPrompt({ key: "a", shiftKey: false })).toBe(false);
  });

  it("closes on Escape", () => {
    expect(shouldCloseQuickPrompt({ key: "Escape" })).toBe(true);
    expect(shouldCloseQuickPrompt({ key: "Enter" })).toBe(false);
  });
});
