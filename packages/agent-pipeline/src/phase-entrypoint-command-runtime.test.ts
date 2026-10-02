import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));

/**
 * Phase entrypoints must resolve their command runtime so that consumer
 * `commands` overrides (AGENT_COMMAND_ID prompts/model/tools) keep working.
 * Review-fix and CI-fix previously regressed here when they were refactored.
 */
const PHASE_ENTRYPOINTS = [
  "plan.ts",
  "implement.ts",
  "yolo.ts",
  "ci-fix.ts",
  "review-fix.ts",
  "ask.ts",
  "code-review.ts",
];

describe("phase entrypoints command runtime wiring", () => {
  for (const entrypoint of PHASE_ENTRYPOINTS) {
    it(`${entrypoint} resolves the command runtime`, () => {
      const source = readFileSync(join(srcDir, entrypoint), "utf8");
      expect(source).toContain(
        'import {\n  applyCommandGithubTools,\n  prepareCommandRuntime,\n} from "./command-runtime.js";',
      );
      expect(source).toMatch(/prepareCommandRuntime\(\s*"[a-z-]+",/);
      expect(source).toContain("cmd.systemPrompt");
      expect(source).toContain(
        "applyCommandGithubTools(tools, cmd.resolved.tools.github)",
      );
      expect(source).toContain("displayLabel: bootCmd.displayLabel");
    });
  }
});
