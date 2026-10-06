import { describe, expect, it } from "vitest";
import {
  decorateCodeReviewBody,
  decorateInlineReviewCommentBody,
  decorateInlineReviewTagLine,
} from "./code-review-display.js";

describe("decorateInlineReviewTagLine", () => {
  it("adds emojis to a standard tag line", () => {
    expect(
      decorateInlineReviewTagLine(
        "_Functional Correctness_ | _Major_ | _Needs discussion_",
      ),
    ).toBe("🐛 _Functional Correctness_ | 🟠 _Major_ | 💬 _Needs discussion_");
  });

  it("is idempotent", () => {
    const once = decorateInlineReviewTagLine("_Docs_ | _Minor_ | _Quick win_");
    expect(decorateInlineReviewTagLine(once)).toBe(once);
  });

  it("returns unknown lines unchanged", () => {
    expect(decorateInlineReviewTagLine("Please fix.")).toBe("Please fix.");
  });
});

describe("decorateInlineReviewCommentBody", () => {
  it("decorates tag line and details summaries", () => {
    const input = `_Security & Privacy_ | _Critical_ | _Quick win_

Explained here.

<details><summary>Suggested fix</summary>

\`\`\`diff
+ fix
\`\`\`

</details>

<details><summary>Evidence</summary>

\`\`\`
rg foo
\`\`\`

</details>`;

    const out = decorateInlineReviewCommentBody(input);
    expect(out).toContain("🔒 _Security & Privacy_");
    expect(out).toContain("🔴 _Critical_");
    expect(out).toContain("✅ _Quick win_");
    expect(out).toContain("<summary>🔧 Suggested fix</summary>");
    expect(out).toContain("<summary>🔍 Evidence</summary>");
  });
});

describe("decorateCodeReviewBody", () => {
  it("prefixes the merge risk level line", () => {
    const body = `## Walkthrough

x

## Merge risk

**Moderate** — auth path touched.

## Standards

none`;

    expect(decorateCodeReviewBody(body)).toContain(
      "## Merge risk\n\n🟡 **Moderate** — auth path touched.",
    );
  });

  it("does not double-prefix merge risk emojis", () => {
    const body = `## Merge risk

🟡 **Moderate** — already done.`;
    expect(decorateCodeReviewBody(body)).toBe(body);
  });
});
