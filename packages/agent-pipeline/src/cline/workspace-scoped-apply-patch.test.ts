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
  listPatchHeaderPaths,
  normalizePatchHeaderPaths,
} from "./workspace-scoped-apply-patch.js";

const workspaceRoot = "/tmp/gha-agent-apply-patch-checkout";

describe("normalizePatchHeaderPaths", () => {
  it("maps /workspace/, bare leading-slash, and absolute checkout paths into the workspace", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /workspace/src/a.ts",
      "+a",
      "*** Update File: /workspace/src/b.ts",
      "@@",
      "*** Delete File: /src/c.ts",
      "*** Update File: src/d.ts",
      "*** Move to: /workspace/src/e.ts",
      `*** Update File: ${workspaceRoot}/src/f.ts`,
      "*** End Patch",
    ].join("\n");

    const normalized = normalizePatchHeaderPaths(patch, workspaceRoot);

    expect(normalized).toContain("*** Add File: src/a.ts");
    expect(normalized).toContain("*** Update File: src/b.ts");
    expect(normalized).toContain("*** Delete File: src/c.ts");
    expect(normalized).toContain("*** Move to: src/e.ts");
    expect(normalized).toContain("*** Update File: src/f.ts");
    expect(normalized).not.toContain("/workspace/");
  });

  it("leaves relative paths untouched", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/d.ts",
      "*** End Patch",
    ].join("\n");

    expect(normalizePatchHeaderPaths(patch, workspaceRoot)).toBe(patch);
  });

  it("leaves paths that cannot be mapped into the workspace untouched", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: ../outside.ts",
      "*** End Patch",
    ].join("\n");

    expect(normalizePatchHeaderPaths(patch, workspaceRoot)).toBe(patch);
  });

  it("lists patch header paths for friction context", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/a.ts",
      "+a",
      "*** Move to: src/b.ts",
      "*** End Patch",
    ].join("\n");

    expect(listPatchHeaderPaths(patch)).toEqual(["src/a.ts", "src/b.ts"]);
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

  it("normalises patch header paths before forwarding the patch", async () => {
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

  it("records runtime/tool_error friction with the normalised paths and rethrows a model-visible hint", async () => {
    const collector = new RunFrictionCollector();
    setActiveRunFrictionCollector(collector);
    mockInnerApplyPatch.mockRejectedValueOnce(new Error("boom"));
    const applyPatch =
      await createWorkspaceScopedApplyPatchExecutor(workspaceRoot);

    await expect(
      applyPatch(
        { input: "*** Begin Patch\n*** Update File: /src/a.ts\n*** End Patch" },
        workspaceRoot,
        {} as never,
      ),
    ).rejects.toThrow("workspace-relative paths");

    expect(collector.noteCount).toBe(1);
    const note = collector.list()[0];
    expect(note.source).toBe("runtime");
    expect(note.category).toBe("tool_error");
    expect(note.summary).toContain("apply_patch: boom");
    expect(note.context).toBe("src/a.ts");
    expect(note.mitigation).toContain("workspace-relative");
  });

  it("keeps the original error message in the thrown recovery error", async () => {
    mockInnerApplyPatch.mockRejectedValueOnce(new Error("boom"));
    const applyPatch =
      await createWorkspaceScopedApplyPatchExecutor(workspaceRoot);

    await expect(
      applyPatch(
        { input: "*** Begin Patch\n*** End Patch" },
        workspaceRoot,
        {} as never,
      ),
    ).rejects.toThrow(/^boom — /);
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
