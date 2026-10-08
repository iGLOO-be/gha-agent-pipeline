import { describe, expect, it } from "vitest";
import { shouldFailNoChanges } from "./push-outcome.js";

describe("shouldFailNoChanges", () => {
  it("fails a non-skip_pr run when there is no open pull request", () => {
    expect(
      shouldFailNoChanges({
        skipPr: false,
        remoteBranchExists: true,
        hasOpenPullRequest: false,
      }),
    ).toBe(true);
  });

  it("succeeds a non-skip_pr re-run with an open pull request", () => {
    expect(
      shouldFailNoChanges({
        skipPr: false,
        remoteBranchExists: true,
        hasOpenPullRequest: true,
      }),
    ).toBe(false);
  });

  it("fails a skip_pr run whose branch was never pushed", () => {
    expect(
      shouldFailNoChanges({
        skipPr: true,
        remoteBranchExists: false,
        hasOpenPullRequest: false,
      }),
    ).toBe(true);
  });

  it("succeeds a skip_pr re-run whose branch is already on the remote", () => {
    expect(
      shouldFailNoChanges({
        skipPr: true,
        remoteBranchExists: true,
        hasOpenPullRequest: false,
      }),
    ).toBe(false);
  });
});
