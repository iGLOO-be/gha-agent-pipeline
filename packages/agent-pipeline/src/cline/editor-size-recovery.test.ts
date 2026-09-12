import { describe, expect, it, afterEach } from "vitest";
import {
  RunFrictionCollector,
  setActiveRunFrictionCollector,
} from "../run-friction.js";
import {
  exceedsEditorArgLimit,
  isOversizedNewFileEditorWrite,
  oversizedEditorRecoveryMessage,
  recordOversizedEditorRunFriction,
} from "./editor-size-recovery.js";

afterEach(() => {
  setActiveRunFrictionCollector(null);
});

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

  it("records tool_limit run friction when editor args are oversized", () => {
    const collector = new RunFrictionCollector();
    setActiveRunFrictionCollector(collector);
    recordOversizedEditorRunFriction("recovery text", "/repo/foo.ts");
    expect(collector.list()[0]?.category).toBe("tool_limit");
    expect(collector.list()[0]?.summary).toContain("editor:");
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
