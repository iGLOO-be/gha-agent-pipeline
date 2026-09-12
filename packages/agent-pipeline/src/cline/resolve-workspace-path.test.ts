import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceFilePath,
  stripWorkspaceAliasPrefix,
} from "./resolve-workspace-path.js";

const root = path.resolve("/tmp/gha-agent-demo-checkout");

describe("resolve-workspace-path", () => {
  it("strips /workspace/ prefix", () => {
    expect(stripWorkspaceAliasPrefix("/workspace/tools/agent/plan.ts")).toBe(
      "/tools/agent/plan.ts",
    );
  });

  it("resolves /workspace/... paths under the checkout root", () => {
    expect(
      resolveWorkspaceFilePath(root, "/workspace/tools/agent/plan.ts"),
    ).toBe(path.join(root, "tools/agent/plan.ts"));
  });

  it("resolves relative paths under the checkout root", () => {
    expect(resolveWorkspaceFilePath(root, "tools/agent/plan.ts")).toBe(
      path.join(root, "tools/agent/plan.ts"),
    );
  });

  it("resolves /README.md to the checkout root README", () => {
    expect(resolveWorkspaceFilePath(root, "/README.md")).toBe(
      path.join(root, "README.md"),
    );
  });
});
