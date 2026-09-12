import { describe, expect, it } from "vitest";
import {
  isMissingOldTextEditorError,
  missingOldTextRecoveryMessage,
} from "./editor-old-text-recovery.js";

describe("editor-old-text-recovery", () => {
  describe("isMissingOldTextEditorError", () => {
    it("matches Cline error without backticks (CI form)", () => {
      expect(
        isMissingOldTextEditorError(
          "Parameter old_text is required when editing an existing file without insert_line",
        ),
      ).toBe(true);
    });

    it("matches error with backticks (upstream form)", () => {
      expect(
        isMissingOldTextEditorError(
          "Parameter `old_text` is required when editing an existing file",
        ),
      ).toBe(true);
    });

    it("does not match unrelated editor errors", () => {
      expect(isMissingOldTextEditorError("Editor input too large: ...")).toBe(
        false,
      );
      expect(isMissingOldTextEditorError("ENOENT: no such file")).toBe(false);
      expect(isMissingOldTextEditorError("")).toBe(false);
    });
  });

  describe("missingOldTextRecoveryMessage", () => {
    it("reports null when old_text was explicitly null", () => {
      const msg = missingOldTextRecoveryMessage("/repo/foo.ts", null);
      expect(msg).toContain("old_text` was null");
      expect(msg).toContain("/repo/foo.ts already exists");
      expect(msg).toContain("read the file first");
    });

    it("reports omitted when old_text was undefined", () => {
      const msg = missingOldTextRecoveryMessage("/repo/foo.ts", undefined);
      expect(msg).toContain("old_text` was omitted");
      expect(msg).toContain("/repo/foo.ts already exists");
    });

    it("steers toward apply_patch or insert_line", () => {
      const msg = missingOldTextRecoveryMessage("bar.ts", undefined);
      expect(msg).toContain("read the file first");
      expect(msg).toContain("insert_line");
      expect(msg).toContain("Do not re-send");
    });
  });
});
