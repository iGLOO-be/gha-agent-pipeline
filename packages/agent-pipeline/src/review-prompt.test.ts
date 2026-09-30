import { describe, expect, it } from "vitest";
import { parseReviewBodyFromAgentOutput } from "./review-prompt.js";

describe("parseReviewBodyFromAgentOutput", () => {
  it("extracts from Walkthrough through the end", () => {
    const output = `Done.\n\n## Walkthrough\n\nSummary\n\n## Standards\n\nNone`;
    expect(parseReviewBodyFromAgentOutput(output)).toBe(
      "## Walkthrough\n\nSummary\n\n## Standards\n\nNone",
    );
  });

  it("falls back to Standards section", () => {
    const output = "## Standards\n\nok\n\n## Spec\n\nnone";
    expect(parseReviewBodyFromAgentOutput(output)).toBe(
      "## Standards\n\nok\n\n## Spec\n\nnone",
    );
  });
});
