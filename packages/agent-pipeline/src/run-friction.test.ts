import { describe, expect, it } from "vitest";
import {
  RunFrictionCollector,
  appendRunFrictionToMarkdown,
  formatRunFrictionMarkdown,
} from "./run-friction.js";

describe("RunFrictionCollector", () => {
  it("records agent and runtime notes with limits", () => {
    const collector = new RunFrictionCollector({ maxNotes: 2 });
    expect(
      collector.record({
        source: "agent",
        category: "inefficient_strategy",
        summary: "Retried editor three times",
      }).accepted,
    ).toBe(true);
    collector.recordRuntimeToolError(
      "read_files",
      "path not found",
      "packages/foo.test.ts",
    );
    expect(collector.noteCount).toBe(2);
    expect(
      collector.record({
        source: "agent",
        category: "other",
        summary: "Dropped",
      }).accepted,
    ).toBe(false);
    expect(collector.droppedNoteCount).toBe(1);
  });

  it("formats markdown and appends to comment bodies", () => {
    const collector = new RunFrictionCollector();
    collector.record({
      source: "agent",
      category: "missing_context",
      summary: "Plan omitted env contract",
      mitigation: "Extend README env table",
    });
    const section = formatRunFrictionMarkdown(collector);
    expect(section).toContain("### Run friction");
    expect(section).toContain("[agent/missing_context]");
    expect(section).toContain("Mitigation:");

    const body = appendRunFrictionToMarkdown("Done.", collector);
    expect(body).toContain("Done.\n\n### Run friction");
  });

  it("returns null markdown when empty", () => {
    const collector = new RunFrictionCollector();
    expect(formatRunFrictionMarkdown(collector)).toBeNull();
    expect(appendRunFrictionToMarkdown("Done.", collector)).toBe("Done.");
  });
});
