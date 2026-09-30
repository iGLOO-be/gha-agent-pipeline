import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.js";
import {
  formatPathInstructionsForPrompt,
  resolveReviewConfig,
} from "./review-config.js";

describe("resolveReviewConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "review-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prefers agent.config over .coderabbit.yaml", () => {
    writeFileSync(
      join(tempDir, ".coderabbit.yaml"),
      [
        "reviews:",
        "  path_filters:",
        '    - "!from-coderabbit/**"',
        "  path_instructions:",
        "    - path: docs/**",
        '      instructions: "from coderabbit"',
      ].join("\n"),
    );

    const config = loadAgentConfig(join(tempDir, "missing.yml"));
    const merged = resolveReviewConfig(
      {
        ...config,
        code_review: {
          path_filters: ["!from-agent/**"],
          path_instructions: [{ path: "src/**", instructions: "from agent" }],
          apply_default_ignores: false,
        },
      },
      tempDir,
    );

    expect(merged.path_filters).toEqual(["!from-agent/**"]);
    expect(merged.path_instructions[0]?.instructions).toBe("from agent");
  });

  it("falls back to .coderabbit.yaml when code_review is absent", () => {
    writeFileSync(
      join(tempDir, ".coderabbit.yaml"),
      ["reviews:", "  path_filters:", '    - "!fallback/**"'].join("\n"),
    );

    const config = loadAgentConfig(join(tempDir, "missing.yml"));
    const merged = resolveReviewConfig(config, tempDir);
    expect(merged.path_filters).toEqual(["!fallback/**"]);
  });
});

describe("formatPathInstructionsForPrompt", () => {
  it("includes only instructions that match reviewed files", () => {
    const block = formatPathInstructionsForPrompt(
      [
        { path: "docs/**", instructions: "Check docs" },
        { path: "src/**", instructions: "Check src" },
      ],
      ["docs/internal/foo.md"],
    );
    expect(block).toContain("docs/**");
    expect(block).not.toContain("Check src");
  });
});
