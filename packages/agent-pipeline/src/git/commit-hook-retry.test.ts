import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommitError } from "./pr.js";
import {
  formatCommitHookRetryPrompt,
  getCommitHookRetryMaxPasses,
  isCommitHookFailure,
  runCommitWithHookRetry,
  shouldRetryCommitHookFailure,
  stripAnsi,
} from "./commit-hook-retry.js";

describe("commit-hook-retry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getCommitHookRetryMaxPasses", () => {
    it("defaults to 2", () => {
      vi.stubEnv("AGENT_COMMIT_HOOK_MAX_PASSES", "");
      expect(getCommitHookRetryMaxPasses()).toBe(2);
    });

    it("clamps AGENT_COMMIT_HOOK_MAX_PASSES to 1–3", () => {
      vi.stubEnv("AGENT_COMMIT_HOOK_MAX_PASSES", "9");
      expect(getCommitHookRetryMaxPasses()).toBe(3);
      vi.stubEnv("AGENT_COMMIT_HOOK_MAX_PASSES", "0");
      expect(getCommitHookRetryMaxPasses()).toBe(1);
    });
  });

  describe("isCommitHookFailure", () => {
    it("detects lint-staged / husky style output", () => {
      expect(
        isCommitHookFailure("✖ Failed to run tasks for staged files!\nhusky"),
      ).toBe(true);
    });

    it("rejects generic git errors", () => {
      expect(isCommitHookFailure("fatal: cannot do a partial commit")).toBe(
        false,
      );
    });
  });

  it("stripAnsi removes color codes", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error");
  });

  describe("shouldRetryCommitHookFailure", () => {
    it("retries hook failures below max passes", () => {
      const error = new GitCommitError("lint-staged failed");
      expect(shouldRetryCommitHookFailure(error, 0, 2)).toBe(true);
      expect(shouldRetryCommitHookFailure(error, 1, 2)).toBe(false);
    });

    it("does not retry non-hook git commit errors", () => {
      const error = new GitCommitError("nothing to commit");
      expect(shouldRetryCommitHookFailure(error, 0, 2)).toBe(false);
    });
  });

  it("formatCommitHookRetryPrompt includes hook log without tool names", () => {
    const prompt = formatCommitHookRetryPrompt("lint-staged: task failed");
    expect(prompt).toContain("git commit hooks rejected");
    expect(prompt).toContain("lint-staged: task failed");
    expect(prompt).not.toMatch(/oxlint/i);
  });

  describe("runCommitWithHookRetry", () => {
    it("relunches once then succeeds", async () => {
      const relaunch = vi.fn(async () => undefined);
      let calls = 0;
      const result = await runCommitWithHookRetry({
        maxPasses: 2,
        commit: async () => {
          calls += 1;
          if (calls === 1) {
            throw new GitCommitError("husky - pre-commit hook failed");
          }
          return "ok";
        },
        relaunchForHookFailure: relaunch,
      });
      expect(result).toBe("ok");
      expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it("throws after max passes", async () => {
      await expect(
        runCommitWithHookRetry({
          maxPasses: 2,
          commit: async () => {
            throw new GitCommitError("Failed to run tasks for staged files!");
          },
          relaunchForHookFailure: async () => undefined,
        }),
      ).rejects.toThrow(/git commit failed/);
    });
  });
});
