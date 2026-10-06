import { describe, expect, it } from "vitest";
import {
  countEditorFileLines,
  invalidInsertLineRecoveryMessage,
  isInvalidInsertLineEditorError,
  normalizeInsertLineForFile,
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

  describe("countEditorFileLines", () => {
    it("counts lines without trailing newline", () => {
      expect(countEditorFileLines("a\nb")).toBe(2);
    });

    it("counts lines with trailing newline", () => {
      expect(countEditorFileLines("a\nb\n")).toBe(2);
    });

    it("returns 0 for empty file", () => {
      expect(countEditorFileLines("")).toBe(0);
    });
  });

  describe("normalizeInsertLineForFile", () => {
    it("clamps EOF off-by-one", () => {
      expect(normalizeInsertLineForFile(236, 235)).toBe(235);
      expect(normalizeInsertLineForFile(21, 20)).toBe(20);
    });

    it("passes through in-range values", () => {
      expect(normalizeInsertLineForFile(10, 235)).toBe(10);
      expect(normalizeInsertLineForFile(235, 235)).toBe(235);
    });

    it("returns null for stale out-of-range values", () => {
      expect(normalizeInsertLineForFile(95, 92)).toBeNull();
      expect(normalizeInsertLineForFile(193, 184)).toBeNull();
    });
  });

  describe("invalidInsertLineRecoveryMessage", () => {
    it("steers toward re-read and EOF line", () => {
      const msg = invalidInsertLineRecoveryMessage("scripts/foo.mjs", 95, 92);
      expect(msg).toContain("1–92");
      expect(msg).toContain("insert_line: 92");
      expect(msg).toContain("re-read");
    });
  });
});
