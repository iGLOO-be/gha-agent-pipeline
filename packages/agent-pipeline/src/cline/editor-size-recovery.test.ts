import { describe, expect, it } from "vitest";
import {
  exceedsEditorArgLimit,
  isOversizedNewFileEditorWrite,
  oversizedEditorRecoveryMessage,
} from "./editor-size-recovery.js";

describe("editor-size-recovery", () => {
  it("detects oversized new-file writes eligible for bypass", () => {
    const input = {
      path: ".github/workflows/agent-phase.yml",
      new_text: "x".repeat(7000),
    };
    expect(exceedsEditorArgLimit(input)).toBe(true);
    expect(isOversizedNewFileEditorWrite(input, false)).toBe(true);
    expect(isOversizedNewFileEditorWrite(input, true)).toBe(false);
  });

  it("does not bypass when old_text or insert_line is set", () => {
    expect(
      isOversizedNewFileEditorWrite(
        {
          path: "a.ts",
          new_text: "x".repeat(7000),
          old_text: "before",
        },
        false,
      ),
    ).toBe(false);
    expect(
      isOversizedNewFileEditorWrite(
        { path: "a.ts", new_text: "x".repeat(7000), insert_line: 1 },
        false,
      ),
    ).toBe(false);
  });

  it("builds recovery guidance for oversized arguments", () => {
    const message = oversizedEditorRecoveryMessage("foo.ts", {
      path: "foo.ts",
      new_text: "n".repeat(7000),
      old_text: "o".repeat(7001),
    });
    expect(message).toContain("7000");
    expect(message).toContain("7001");
    expect(message).toContain("apply_patch");
  });
});
