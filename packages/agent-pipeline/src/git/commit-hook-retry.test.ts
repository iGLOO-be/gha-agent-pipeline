import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitError } from "./pr.js";

const { mockRunShell } = vi.hoisted(() => ({
  mockRunShell: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 1,
  })),
}));

vi.mock("../tools/shell.js", () => ({
  runShell: mockRunShell,
}));

import {
  formatCommitHookRetryPrompt,
  getCommitHookRetryMaxPasses,
  hasInstalledCommitHooks,
  isCommitHookFailure,
  isCommitHookFailureLike,
  isKnownNonHookGitFailure,
  runCommitWithHookRetry,
  shouldRetryCommitHookFailure,
  stripAnsi,
} from "./commit-hook-retry.js";

describe("commit-hook-retry", () => {
  beforeEach(() => {
    mockRunShell.mockResolvedValue({ stdout: "", stderr: "", exitCode: 1 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockRunShell.mockReset();
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

  describe("isCommitHookFailureLike", () => {
    it("accepts unmarked output when hooks are installed", () => {
      const preCommitCom = "- hook id: eslint\n- exit code: 1";
      expect(isCommitHookFailure(preCommitCom)).toBe(false);
      expect(isCommitHookFailureLike(preCommitCom, false)).toBe(false);
      expect(isCommitHookFailureLike(preCommitCom, true)).toBe(true);
    });

    it("still rejects known non-hook git errors when hooks are installed", () => {
      expect(
        isKnownNonHookGitFailure("fatal: cannot do a partial commit"),
      ).toBe(true);
      expect(
        isCommitHookFailureLike("fatal: cannot do a partial commit", true),
      ).toBe(false);
    });

    it("never treats empty output as a hook failure", () => {
      expect(isCommitHookFailureLike("", true)).toBe(false);
      expect(isCommitHookFailureLike("  \n\t", true)).toBe(false);
    });

    it("rejects permission/disk git errors when hooks are installed", () => {
      const permission =
        "fatal: Unable to create '/repo/.git/COMMIT_EDITMSG': Permission denied";
      expect(isKnownNonHookGitFailure(permission)).toBe(true);
      expect(isCommitHookFailureLike(permission, true)).toBe(false);
      expect(
        isCommitHookFailureLike("fatal: failed to write commit object", true),
      ).toBe(false);
      expect(
        isCommitHookFailureLike("fatal: No space left on device", true),
      ).toBe(false);
    });

    it("still treats hook output mentioning permission denied as a hook failure", () => {
      // A custom hook runner may print "permission denied" while the hook is
      // what exited non-zero; only the git-specific `fatal: unable to ...`
      // form should short-circuit the installed-hooks fallback.
      const hookLog =
        "- hook id: check-perms\n- exit code: 1\nchmod: permission denied";
      expect(isKnownNonHookGitFailure(hookLog)).toBe(false);
      expect(isCommitHookFailureLike(hookLog, true)).toBe(true);
    });
  });

  describe("hasInstalledCommitHooks", () => {
    it("returns true when core.hooksPath is configured", async () => {
      mockRunShell.mockResolvedValueOnce({
        stdout: ".husky\n",
        stderr: "",
        exitCode: 0,
      });
      expect(await hasInstalledCommitHooks()).toBe(true);
    });

    it("detects real (non-sample) hooks under the hooks dir", async () => {
      const dir = mkdtempSync(join(tmpdir(), "commit-hook-retry-"));
      try {
        writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\nexit 1\n");
        mockRunShell
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
          .mockResolvedValueOnce({
            stdout: `${dir}\n`,
            stderr: "",
            exitCode: 0,
          });
        expect(await hasInstalledCommitHooks()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores a hooks dir that only contains samples", async () => {
      const dir = mkdtempSync(join(tmpdir(), "commit-hook-retry-"));
      try {
        writeFileSync(join(dir, "pre-commit.sample"), "#!/bin/sh\n");
        mockRunShell
          .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1 })
          .mockResolvedValueOnce({
            stdout: `${dir}\n`,
            stderr: "",
            exitCode: 0,
          });
        expect(await hasInstalledCommitHooks()).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

    it("falls back to installed hooks for unrecognized runners", () => {
      const error = new GitCommitError("- hook id: eslint\n- exit code: 1");
      expect(shouldRetryCommitHookFailure(error, 0, 2, false)).toBe(false);
      expect(shouldRetryCommitHookFailure(error, 0, 2, true)).toBe(true);
    });

    it("does not fall back to installed hooks for known non-hook errors", () => {
      const error = new GitCommitError("fatal: cannot do a partial commit");
      expect(shouldRetryCommitHookFailure(error, 0, 2, true)).toBe(false);
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

    it("relaunches for unmarked output when commit hooks are installed", async () => {
      mockRunShell.mockResolvedValue({
        stdout: ".husky\n",
        stderr: "",
        exitCode: 0,
      });
      const relaunch = vi.fn(async () => undefined);
      let calls = 0;
      const result = await runCommitWithHookRetry({
        maxPasses: 2,
        commit: async () => {
          calls += 1;
          if (calls === 1) {
            throw new GitCommitError("- hook id: eslint\n- exit code: 1");
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

    it("only warns about unmatched patterns, not exhausted hook retries", async () => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const warnedAboutNoMatch = () =>
        warn.mock.calls.some((args) =>
          String(args[0]).includes("did not match known hook-failure patterns"),
        );

      try {
        // Matched marker + exhausted budget → no heuristic-gap warning.
        await expect(
          runCommitWithHookRetry({
            maxPasses: 2,
            commit: async () => {
              throw new GitCommitError("Failed to run tasks for staged files!");
            },
            relaunchForHookFailure: async () => undefined,
          }),
        ).rejects.toThrow(/git commit failed/);
        expect(warnedAboutNoMatch()).toBe(false);

        // Unmatched output → heuristic-gap warning.
        await expect(
          runCommitWithHookRetry({
            maxPasses: 1,
            commit: async () => {
              throw new GitCommitError("fatal: cannot do a partial commit");
            },
            relaunchForHookFailure: async () => undefined,
          }),
        ).rejects.toThrow(/git commit failed/);
        expect(warnedAboutNoMatch()).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
