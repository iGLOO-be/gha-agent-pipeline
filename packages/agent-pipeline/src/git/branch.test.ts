import { describe, expect, it } from "vitest";
import { branchName, resolveYoloBranchName, slugifyTitle } from "./branch.js";

describe("git/branch", () => {
  describe("slugifyTitle", () => {
    it("lowercases the title", () => {
      expect(slugifyTitle("Hello World")).toBe("hello-world");
    });

    it("collapses non-alphanumeric characters into a single dash", () => {
      expect(slugifyTitle("a!@b##c")).toBe("a-b-c");
    });

    it("trims leading and trailing dashes", () => {
      expect(slugifyTitle("-leading-and-trailing-")).toBe(
        "leading-and-trailing",
      );
    });

    it("caps the slug at 40 characters", () => {
      const longTitle = "a".repeat(100);
      expect(slugifyTitle(longTitle).length).toBe(40);
    });
  });

  describe("branchName", () => {
    it("builds agent/<number>-<slug>", () => {
      expect(branchName(88, "Tests unitaires Vitest")).toBe(
        "agent/88-tests-unitaires-vitest",
      );
    });

    it("uses a configurable prefix", () => {
      expect(branchName(88, "Tests unitaires Vitest", "bot")).toBe(
        "bot/88-tests-unitaires-vitest",
      );
    });

    it("falls back to 'change' for an empty slug", () => {
      expect(branchName(42, "!!!")).toBe("agent/42-change");
    });

    it("falls back to 'change' for an empty slug with a custom prefix", () => {
      expect(branchName(42, "!!!", "bot")).toBe("bot/42-change");
    });
  });

  describe("resolveYoloBranchName", () => {
    it("uses AGENT_BRANCH when provided", () => {
      expect(
        resolveYoloBranchName(99, "Some title", "feature/existing-branch"),
      ).toBe("feature/existing-branch");
    });

    it("falls back to branchName when AGENT_BRANCH is omitted", () => {
      expect(resolveYoloBranchName(42, "Add widgets", undefined, "bot")).toBe(
        branchName(42, "Add widgets", "bot"),
      );
    });
  });
});
