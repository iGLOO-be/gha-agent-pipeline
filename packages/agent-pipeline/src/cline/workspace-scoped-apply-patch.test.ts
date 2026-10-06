import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunFrictionCollector,
  setActiveRunFrictionCollector,
} from "../run-friction.js";

const mockInnerApplyPatch = vi.hoisted(() => vi.fn());
const mockLoadClineSdk = vi.hoisted(() =>
  vi.fn(async () => ({
    createDefaultExecutors: () => ({ applyPatch: mockInnerApplyPatch }),
  })),
);

vi.mock("../cline.js", () => ({ loadClineSdk: mockLoadClineSdk }));

import {
  createWorkspaceScopedApplyPatchExecutor,
  normalizePatchWorkspaceAliases,
} from "./workspace-scoped-apply-patch.js";

const workspaceRoot = "/tmp/gha-agent-apply-patch-checkout";

describe("normalizePatchWorkspaceAliases", () => {
  it("strips /workspace/ from Add/Update/Delete/Move headers", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/a.ts",
      "+a",
      "*** Update File: /workspace/src/b.ts",
      "@@",
      "*** Delete File: /workspace/src/c.ts",
      "*** Update File: src/d.ts",
      "*** Move to: /workspace/src/e.ts",
      "*** End Patch",
    ].join("\n");

    const normalized = normalizePatchWorkspaceAliases(patch);

    expect(normalized).toContain("*** Add File: src/a.ts");
    expect(normalized).toContain("*** Update File: src/b.ts");
    expect(normalized).toContain("*** Delete File: src/c.ts");
    expect(normalized).toContain("*** Move to: src/e.ts");
    expect(normalized).not.toContain("/workspace/");
  });

  it("leaves relative paths untouched", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/d.ts",
      "*** End Patch",
    ].join("\n");

    expect(normalizePatchWorkspaceAliases(patch)).toBe(patch);
  });
});

describe("createWorkspaceScopedApplyPatchExecutor", () => {
  beforeEach(() => {
    mockInnerApplyPatch.mockReset();
    mockLoadClineSdk.mockClear();
    setActiveRunFrictionCollector(null);
  });

  afterEach(() => {
    setActiveRunFrictionCollector(null);
  });

  it("forwards the workspace root as cwd even when called with another cwd", async () => {
    mockInnerApplyPatch.mockResolvedValueOnce("applied");
    const applyPatch =
      await createWorkspaceScopedApplyPatchExecutor(workspaceRoot);

    const result = await applyPatch(
      { input: "*** Begin Patch\n*** End Patch" },
      "/some/other/cwd",
      {} as never,
    );

    expect(result).toBe("applied");
    expect(mockInnerApplyPatch).toHaveBeenCalledWith(
      { input: "*** Begin Patch\n*** End Patch" },
      workspaceRoot,
      {},
    );
  });

  it("normalises /workspace/ aliases before forwarding the patch", async () => {
    mockInnerApplyPatch.mockResolvedValueOnce("applied");
    const applyPatch =
      await createWorkspaceScopedApplyPatchExecutor(workspaceRoot);

    await applyPatch(
      { input: "*** Begin Patch\n*** Add File: /workspace/a.ts\n+a\n" },
      workspaceRoot,
      {} as never,
    );

    expect(mockInnerApplyPatch).toHaveBeenCalledWith(
      { input: "*** Begin Patch\n*** Add File: a.ts\n+a\n" },
      workspaceRoot,
      {},
    );
  });

  it("records runtime/tool_limit friction with an editor hint and rethrows", async () => {
    const collector = new RunFrictionCollector();
    setActiveRunFrictionCollector(collector);
    mockInnerApplyPatch.mockRejectedValueOnce(new Error("boom"));
    const applyPatch =
      await createWorkspaceScopedApplyPatchExecutor(workspaceRoot);

    await expect(
      applyPatch(
        { input: "*** Begin Patch\n*** End Patch" },
        workspaceRoot,
        {} as never,
      ),
    ).rejects.toThrow("boom");

    expect(collector.noteCount).toBe(1);
    const note = collector.list()[0];
    expect(note.source).toBe("runtime");
    expect(note.category).toBe("tool_limit");
    expect(note.summary).toContain("apply_patch: boom");
    expect(note.mitigation).toContain("editor");
  });

  it("throws a descriptive error when the SDK exposes no applyPatch executor", async () => {
    mockLoadClineSdk.mockResolvedValueOnce({
      createDefaultExecutors: () => ({}),
    } as never);

    await expect(
      createWorkspaceScopedApplyPatchExecutor(workspaceRoot),
    ).rejects.toThrow("applyPatch executor is unavailable");
  });
});
