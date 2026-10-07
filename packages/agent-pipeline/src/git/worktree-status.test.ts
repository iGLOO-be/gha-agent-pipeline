import { describe, expect, it } from "vitest";
import {
  commitsAheadOfBaseCommand,
  shouldWarnNoYoloChanges,
} from "./worktree-status.js";

describe("shouldWarnNoYoloChanges", () => {
  it("warns when the tree is clean and HEAD matches the base branch", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: "", exitCode: 0 },
        { stdout: "0\n", exitCode: 0 },
      ),
    ).toBe(true);
  });

  it("does not warn when the working tree has changes", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: " M src/index.ts\n", exitCode: 0 },
        { stdout: "0\n", exitCode: 0 },
      ),
    ).toBe(false);
  });

  it("does not warn for untracked-only changes (porcelain is untracked-aware)", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: "?? src/new-file.ts\n", exitCode: 0 },
        { stdout: "0\n", exitCode: 0 },
      ),
    ).toBe(false);
  });

  it("does not warn when the session committed its own work (clean tree, ahead of base)", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: "", exitCode: 0 },
        { stdout: "1\n", exitCode: 0 },
      ),
    ).toBe(false);
  });

  it("stays silent when the worktree probe fails", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: "", exitCode: 128 },
        { stdout: "0\n", exitCode: 0 },
      ),
    ).toBe(false);
  });

  it("stays silent when the commits-ahead probe fails (missing origin ref)", () => {
    expect(
      shouldWarnNoYoloChanges(
        { stdout: "", exitCode: 0 },
        { stdout: "", exitCode: 128 },
      ),
    ).toBe(false);
  });
});

describe("commitsAheadOfBaseCommand", () => {
  it("counts commits between the remote base branch and HEAD", () => {
    expect(commitsAheadOfBaseCommand("main")).toBe(
      "git rev-list --count origin/main..HEAD",
    );
  });
});
