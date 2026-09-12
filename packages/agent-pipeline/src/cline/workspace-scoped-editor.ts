import { access } from "node:fs/promises";
import { loadClineSdk } from "../cline.js";
import {
  isMissingOldTextEditorError,
  missingOldTextRecoveryMessage,
} from "./editor-old-text-recovery.js";
import {
  editorBypassSuccessResult,
  exceedsEditorArgLimit,
  isEditorInputTooLargeError,
  isOversizedNewFileEditorWrite,
  oversizedEditorRecoveryMessage,
  recordOversizedEditorRunFriction,
  writeNewFileBypassingEditorLimit,
} from "./editor-size-recovery.js";
import { getActiveRunFrictionCollector } from "../run-friction.js";
import { resolveWorkspaceFilePath } from "./resolve-workspace-path.js";

function editorResultError(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as { success?: boolean; error?: unknown };
  if (typeof record.error === "string" && record.error.length > 0) {
    return record.error;
  }
  if (record.success === false && typeof record.error === "string") {
    return record.error;
  }
  return null;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function editorFailureResult(displayPath: string, error: string) {
  return {
    success: false as const,
    query: `edit:${displayPath}`,
    result: "",
    error,
  };
}

/**
 * Workspace-aware wrapper around Cline’s default `editor` executor.
 *
 * - **Paths** — resolve `read_files` / `editor` paths against the checkout root.
 * - **Missing `old_text`** — clearer errors (`editor-old-text-recovery.ts`).
 * - **6000-char tool args** — bypass + recovery (`editor-size-recovery.ts`); see
 *   that module’s file comment for background and when to remove the workaround.
 * - **Run friction** — record non-fatal editor failures for phase summaries.
 */
export async function createWorkspaceScopedEditorExecutor(
  workspaceRoot: string,
) {
  const { createDefaultExecutors } = await loadClineSdk();
  const inner = createDefaultExecutors().editor;
  if (!inner) {
    throw new Error("Cline default editor executor is unavailable");
  }

  type EditorRequest = Parameters<typeof inner>[0];
  type AgentToolContext = Parameters<typeof inner>[2];

  return async (
    input: EditorRequest,
    cwd: string,
    context: AgentToolContext,
  ) => {
    const displayPath = input.path;
    const resolvedPath = resolveWorkspaceFilePath(workspaceRoot, input.path);
    const normalizedInput = { ...input, path: resolvedPath };
    const fileExists = await pathExists(resolvedPath);

    // Pre-flight: prevent Cline call when existing file is edited without
    // old_text or insert_line; return recovery message directly instead of
    // waiting for Cline to reject it (which it always does).
    const hasOldText =
      typeof normalizedInput.old_text === "string" &&
      normalizedInput.old_text.length > 0;
    const hasInsertLine =
      typeof normalizedInput.insert_line === "number" &&
      normalizedInput.insert_line > 0;
    if (fileExists && !hasOldText && !hasInsertLine) {
      const recovery = missingOldTextRecoveryMessage(
        displayPath,
        normalizedInput.old_text,
      );
      return editorFailureResult(displayPath, recovery);
    }

    if (exceedsEditorArgLimit(normalizedInput)) {
      if (isOversizedNewFileEditorWrite(normalizedInput, fileExists)) {
        await writeNewFileBypassingEditorLimit(
          resolvedPath,
          normalizedInput.new_text,
        );
        return editorBypassSuccessResult(
          displayPath,
          normalizedInput.new_text.length,
        );
      }

      const recovery = oversizedEditorRecoveryMessage(
        displayPath,
        normalizedInput,
      );
      recordOversizedEditorRunFriction(recovery, resolvedPath);
      return editorFailureResult(displayPath, recovery);
    }

    try {
      const result = await inner(normalizedInput, cwd, context);
      const toolError = editorResultError(result);
      if (toolError) {
        if (isEditorInputTooLargeError(toolError)) {
          const existsAfter = await pathExists(resolvedPath);
          if (isOversizedNewFileEditorWrite(normalizedInput, existsAfter)) {
            await writeNewFileBypassingEditorLimit(
              resolvedPath,
              normalizedInput.new_text,
            );
            return editorBypassSuccessResult(
              displayPath,
              normalizedInput.new_text.length,
            );
          }

          const recovery = oversizedEditorRecoveryMessage(
            displayPath,
            normalizedInput,
          );
          recordOversizedEditorRunFriction(recovery, resolvedPath);
          if (result && typeof result === "object") {
            return { ...result, error: recovery };
          }
          return editorFailureResult(displayPath, recovery);
        }

        if (isMissingOldTextEditorError(toolError)) {
          const recovery = missingOldTextRecoveryMessage(
            displayPath,
            normalizedInput.old_text,
          );
          if (result && typeof result === "object") {
            return { ...result, error: recovery };
          }
          return editorFailureResult(displayPath, recovery);
        }

        getActiveRunFrictionCollector()?.recordRuntimeToolError(
          "editor",
          toolError,
          resolvedPath,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingOldTextEditorError(message)) {
        throw new Error(
          missingOldTextRecoveryMessage(resolvedPath, input.old_text),
        );
      }
      getActiveRunFrictionCollector()?.recordRuntimeToolError(
        "editor",
        message,
        resolvedPath,
      );
      throw error;
    }
  };
}
