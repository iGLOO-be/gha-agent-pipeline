import { describe, expect, it } from "vitest";
import {
  invalidInsertLineRecoveryMessage,
  isInsertLineHandledByCline,
  isInvalidInsertLineEditorError,
  maxInsertLineForFile,
  parseInvalidInsertLineError,
} from "./editor-insert-line-recovery.js";

const FOLDIO_ERROR =
  "Invalid insert_line: 236. insert_line must be a positive one-based boundary line in the range 1-235. Use 235 to append at EOF.";

describe("editor-insert-line-recovery", () => {
  describe("parseInvalidInsertLineError", () => {
    it("parses Foldio friction message", () => {
      expect(parseInvalidInsertLineError(FOLDIO_ERROR)).toEqual({
        attempted: 236,
        maxLine: 235,
        appendAtEofLine: 235,
      });
    });

    it("returns null for unrelated errors", () => {
      expect(parseInvalidInsertLineError("Editor input too large")).toBeNull();
    });
  });

  describe("isInvalidInsertLineEditorError", () => {
    it("matches Cline invalid insert_line errors", () => {
      expect(isInvalidInsertLineEditorError(FOLDIO_ERROR)).toBe(true);
    });
  });

  describe("maxInsertLineForFile", () => {
    it("matches Cline's bound (newlineCount + 2) without a trailing newline", () => {
      expect(maxInsertLineForFile("a\nb")).toBe(3);
    });

    it("matches Cline's bound with a trailing newline", () => {
      expect(maxInsertLineForFile("a\nb\n")).toBe(4);
    });

    it("accepts 1..2 for an empty file", () => {
      expect(maxInsertLineForFile("")).toBe(2);
    });

    it("matches Cline's bound for a single line", () => {
      expect(maxInsertLineForFile("a")).toBe(2);
    });
  });

  describe("isInsertLineHandledByCline", () => {
    it("handles a valid EOF append (lineCount + 1) without rewriting it", () => {
      // Cline accepts 1..3 for "line one\nline two"; 3 appends at EOF.
      expect(isInsertLineHandledByCline(3, 3)).toBe(true);
      expect(isInsertLineHandledByCline(2, 3)).toBe(true);
    });

    it("handles the out-of-range off-by-one so the SDK retry can fix it", () => {
      expect(isInsertLineHandledByCline(4, 3)).toBe(true);
    });

    it("handles in-range values", () => {
      expect(isInsertLineHandledByCline(10, 235)).toBe(true);
      expect(isInsertLineHandledByCline(235, 235)).toBe(true);
      expect(isInsertLineHandledByCline(1, 2)).toBe(true);
    });

    it("rejects stale out-of-range values", () => {
      expect(isInsertLineHandledByCline(95, 92)).toBe(false);
      expect(isInsertLineHandledByCline(193, 184)).toBe(false);
      expect(isInsertLineHandledByCline(5, 3)).toBe(false);
    });
  });

  describe("invalidInsertLineRecoveryMessage", () => {
    it("steers toward re-read and the line after the last read line", () => {
      const msg = invalidInsertLineRecoveryMessage("scripts/foo.mjs", 95, 92);
      expect(msg).toContain("1–92");
      // Reserving `maxLine` for the upper bound only keeps this message
      // consistent with FILE_EDIT_SYSTEM_HINT, which tells the model to append
      // at `line_count + 1`; `maxLine` itself adds a blank line on files that
      // end with a newline.
      expect(msg).toContain("line_count + 1");
      expect(msg).toContain("re-read");
    });

    it("reports Cline's bound for an empty existing file", () => {
      const msg = invalidInsertLineRecoveryMessage("empty.txt", 5, 2);
      expect(msg).toContain("1–2");
      expect(msg).toContain("line_count + 1");
    });
  });
});
