import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveRunFrictionCollector,
  RunFrictionCollector,
} from "../run-friction.js";

const mockInnerEditor = vi.hoisted(() => vi.fn());
const mockLoadClineSdk = vi.hoisted(() =>
  vi.fn(async () => ({
    createDefaultExecutors: () => ({ editor: mockInnerEditor }),
  })),
);

vi.mock("../cline.js", () => ({ loadClineSdk: mockLoadClineSdk }));

import { createWorkspaceScopedEditorExecutor } from "./workspace-scoped-editor.js";

describe("workspace-scoped-editor pre-flight", () => {
  let workspaceRoot: string;
  let existingFile: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ws-edit-test-"));
    existingFile = path.join(workspaceRoot, "exists.txt");
    const fh = await open(existingFile, "w");
    await fh.writeFile("original content");
    await fh.close();
    mockInnerEditor.mockReset();
    mockLoadClineSdk.mockClear();
    setActiveRunFrictionCollector(null);
  });

  afterEach(async () => {
    setActiveRunFrictionCollector(null);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("returns recovery message when editing existing file without old_text or insert_line", async () => {
    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "exists.txt", new_text: "replacement" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("exists.txt already exists");
    expect(result.error).toContain("old_text");
    // Must not call inner Cline editor
    expect(mockInnerEditor).not.toHaveBeenCalled();
  });

  it("does NOT record run friction for pre-flight short-circuit", async () => {
    const collector = new RunFrictionCollector();
    setActiveRunFrictionCollector(collector);

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    await editor(
      { path: "exists.txt", new_text: "replacement" },
      workspaceRoot,
      {} as never,
    );

    expect(collector.noteCount).toBe(0);
  });

  it("passes through when old_text is provided", async () => {
    mockInnerEditor.mockResolvedValueOnce({
      success: true,
      query: "edit:exists.txt",
      result: "ok",
      error: "",
    });
    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "exists.txt", old_text: "original content", new_text: "new" },
      workspaceRoot,
      {} as never,
    );

    expect(mockInnerEditor).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("returns recovery from toolError branch when inner returns success:false with old_text error", async () => {
    // This edge case is reachable when pre-flight passes (e.g. insert_line
    // provided but Cline rejects it anyway) or fileExists races.
    mockInnerEditor.mockResolvedValueOnce({
      success: false,
      query: "edit:exists.txt",
      result: "",
      error:
        "Parameter old_text is required when editing an existing file without insert_line",
    });
    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "exists.txt", insert_line: 1, new_text: "line" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("old_text");
    expect(mockInnerEditor).toHaveBeenCalledTimes(1);
  });
});
