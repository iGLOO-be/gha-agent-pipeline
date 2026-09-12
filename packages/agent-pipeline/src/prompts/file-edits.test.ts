import { describe, expect, it } from "vitest";
import {
  CLINE_EDITOR_ARG_CHAR_LIMIT,
  FILE_EDIT_SYSTEM_HINT,
} from "./file-edits.js";

describe("FILE_EDIT_SYSTEM_HINT", () => {
  it("documents the Cline editor per-argument size limit", () => {
    expect(CLINE_EDITOR_ARG_CHAR_LIMIT).toBe(6000);
    expect(FILE_EDIT_SYSTEM_HINT).toContain("6000");
    expect(FILE_EDIT_SYSTEM_HINT).toContain("Editor input too large");
    expect(FILE_EDIT_SYSTEM_HINT).toContain("apply_patch");
  });
});
