import { describe, expect, it } from "vitest";
import {
  invalidInsertLineRecoveryMessage,
  isInvalidInsertLineEditorError,
  maxInsertLineForFile,
  parseInvalidInsertLineError,
  resolveInsertLineForCline,
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

  describe("resolveInsertLineForCline", () => {
    it("does not rewrite a valid EOF append (lineCount + 1)", () => {
      // Cline accepts 1..3 for "line one\nline two"; 3 appends at EOF.
      expect(resolveInsertLineForCline(3, 3)).toBe(3);
      expect(resolveInsertLineForCline(2, 3)).toBe(2);
    });

    it("passes through the out-of-range off-by-one so the SDK retry can fix it", () => {
      expect(resolveInsertLineForCline(4, 3)).toBe(4);
    });

    it("passes through in-range values", () => {
      expect(resolveInsertLineForCline(10, 235)).toBe(10);
      expect(resolveInsertLineForCline(235, 235)).toBe(235);
      expect(resolveInsertLineForCline(1, 2)).toBe(1);
    });

    it("returns null for stale out-of-range values", () => {
      expect(resolveInsertLineForCline(95, 92)).toBeNull();
      expect(resolveInsertLineForCline(193, 184)).toBeNull();
      expect(resolveInsertLineForCline(5, 3)).toBeNull();
    });
  });

  describe("invalidInsertLineRecoveryMessage", () => {
    it("steers toward re-read and EOF line", () => {
      const msg = invalidInsertLineRecoveryMessage("scripts/foo.mjs", 95, 92);
      expect(msg).toContain("1–92");
      expect(msg).toContain("insert_line: 92");
      expect(msg).toContain("re-read");
    });

    it("reports Cline's bound for an empty existing file", () => {
      const msg = invalidInsertLineRecoveryMessage("empty.txt", 5, 2);
      expect(msg).toContain("1–2");
      expect(msg).toContain("insert_line: 2");
    });
  });
});
