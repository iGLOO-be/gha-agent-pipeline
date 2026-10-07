import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
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

describe("workspace-scoped-editor insert_line recovery", () => {
  let workspaceRoot: string;
  let existingFile: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "ws-insert-line-"));
    existingFile = path.join(workspaceRoot, "two-lines.txt");
    const fh = await open(existingFile, "w");
    await fh.writeFile("line one\nline two");
    await fh.close();
    mockInnerEditor.mockReset();
    mockLoadClineSdk.mockClear();
    setActiveRunFrictionCollector(null);
  });

  afterEach(async () => {
    setActiveRunFrictionCollector(null);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("passes through a valid EOF append insert_line before calling Cline", async () => {
    mockInnerEditor.mockResolvedValueOnce({
      success: true,
      query: "edit:two-lines.txt",
      result: "ok",
      error: "",
    });
    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "two-lines.txt", insert_line: 3, new_text: "line three\n" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(true);
    expect(mockInnerEditor).toHaveBeenCalledTimes(1);
    // 3 is Cline's max for this file, i.e. the documented EOF append.
    expect(mockInnerEditor.mock.calls[0][0].insert_line).toBe(3);
  });

  it("allows insert_line 1 on an empty existing file", async () => {
    const emptyFile = path.join(workspaceRoot, "empty.txt");
    const fh = await open(emptyFile, "w");
    await fh.close();
    mockInnerEditor.mockResolvedValueOnce({
      success: true,
      query: "edit:empty.txt",
      result: "ok",
      error: "",
    });

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "empty.txt", insert_line: 1, new_text: "first line\n" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(true);
    expect(mockInnerEditor).toHaveBeenCalledTimes(1);
    expect(mockInnerEditor.mock.calls[0][0].insert_line).toBe(1);
  });

  it("returns recovery for stale insert_line without recording friction", async () => {
    const collector = new RunFrictionCollector();
    setActiveRunFrictionCollector(collector);

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "two-lines.txt", insert_line: 5, new_text: "x\n" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("1–3");
    expect(result.error).toContain("line_count + 1");
    expect(result.error).not.toContain(workspaceRoot);
    expect(mockInnerEditor).not.toHaveBeenCalled();
    expect(collector.noteCount).toBe(0);
  });

  it("retries once when Cline reports EOF off-by-one", async () => {
    mockInnerEditor
      .mockResolvedValueOnce({
        success: false,
        query: "edit:two-lines.txt",
        result: "",
        error:
          "Invalid insert_line: 4. insert_line must be a positive one-based boundary line in the range 1-3. Use 3 to append at EOF.",
      })
      .mockResolvedValueOnce({
        success: true,
        query: "edit:two-lines.txt",
        result: "ok",
        error: "",
      });

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "two-lines.txt", insert_line: 4, new_text: "appended\n" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(true);
    expect(mockInnerEditor).toHaveBeenCalledTimes(2);
    // First attempt passes through unchanged; retry uses Cline's EOF line.
    expect(mockInnerEditor.mock.calls[0][0].insert_line).toBe(4);
    expect(mockInnerEditor.mock.calls[1][0].insert_line).toBe(3);
  });

  it("retries at the no-blank-line EOF boundary for files ending with a newline", async () => {
    const trailingFile = path.join(workspaceRoot, "trailing.txt");
    const fh = await open(trailingFile, "w");
    await fh.writeFile("line one\nline two\n");
    await fh.close();
    mockInnerEditor
      .mockResolvedValueOnce({
        success: false,
        query: "edit:trailing.txt",
        result: "",
        error:
          "Invalid insert_line: 5. insert_line must be a positive one-based boundary line in the range 1-4. Use 4 to append at EOF.",
      })
      .mockResolvedValueOnce({
        success: true,
        query: "edit:trailing.txt",
        result: "ok",
        error: "",
      });

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "trailing.txt", insert_line: 5, new_text: "appended\n" },
      workspaceRoot,
      {} as never,
    );

    expect(result.success).toBe(true);
    expect(mockInnerEditor).toHaveBeenCalledTimes(2);
    // Cline's `appendAtEofLine` is 4, which would leave a stray blank line;
    // the no-blank-line boundary is `line_count + 1` === 3.
    expect(mockInnerEditor.mock.calls[1][0].insert_line).toBe(3);
  });

  it("defers to Cline when the path is not a readable file", async () => {
    // access() succeeds on directories, so readFile is the first failing call.
    const dirPath = path.join(workspaceRoot, "dir.txt");
    await mkdir(dirPath, { recursive: true });
    mockInnerEditor.mockResolvedValueOnce({
      success: false,
      query: "edit:dir.txt",
      result: "",
      error: "Path is a directory",
    });

    const editor = await createWorkspaceScopedEditorExecutor(workspaceRoot);
    const result = await editor(
      { path: "dir.txt", insert_line: 2, new_text: "x\n" },
      workspaceRoot,
      {} as never,
    );

    // The read failure must not throw out of the executor; Cline owns the error.
    expect(mockInnerEditor).toHaveBeenCalledTimes(1);
    expect(mockInnerEditor.mock.calls[0][0].insert_line).toBe(2);
    expect(result.success).toBe(false);
  });
});
