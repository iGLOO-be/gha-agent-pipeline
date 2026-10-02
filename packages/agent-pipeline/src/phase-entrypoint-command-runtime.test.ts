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
  "ask.ts",
  "code-review.ts",
];

/**
 * `ci-fix` / `review-fix` are thin wrappers over the unified `runFixPhase`
 * runtime: the wrappers build `bootCmd` for the startup label and delegate,
 * while `fix-phase.ts` owns the shared session wiring.
 */
const FIX_ENTRYPOINTS = [
  { entrypoint: "ci-fix.ts", phase: "ci-fix" },
  { entrypoint: "review-fix.ts", phase: "review-fix" },
];

const UNIFIED_FIX_RUNTIME = "fix-phase.ts";

function readSource(file: string): string {
  return readFileSync(join(srcDir, file), "utf8");
}

describe("phase entrypoints command runtime wiring", () => {
  for (const entrypoint of PHASE_ENTRYPOINTS) {
    it(`${entrypoint} resolves the command runtime`, () => {
      const source = readSource(entrypoint);
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

  for (const { entrypoint, phase } of FIX_ENTRYPOINTS) {
    it(`${entrypoint} delegates to the unified fix runtime`, () => {
      const source = readSource(entrypoint);
      expect(source).toContain('from "./command-runtime.js"');
      expect(source).toMatch(
        new RegExp(`prepareCommandRuntime\\(\\s*"${phase}",`),
      );
      expect(source).toContain(`runFixPhase("${phase}", env)`);
      expect(source).toContain("displayLabel: bootCmd.displayLabel");
    });
  }

  it(`${UNIFIED_FIX_RUNTIME} wires the resolved command runtime`, () => {
    const source = readSource(UNIFIED_FIX_RUNTIME);
    expect(source).toContain("prepareCommandRuntime(");
    expect(source).toContain("cmd.systemPrompt");
    expect(source).toContain(
      "applyCommandGithubTools(tools, cmd.resolved.tools.github)",
    );
  });
});
