import { access, readFile } from "node:fs/promises";
import { loadClineSdk } from "../cline.js";
import {
  invalidInsertLineRecoveryMessage,
  isInsertLineHandledByCline,
  isInvalidInsertLineEditorError,
  maxInsertLineForFile,
  parseInvalidInsertLineError,
} from "./editor-insert-line-recovery.js";
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
 * Pre-flight guard for `insert_line` on an existing file: returns a recovery
 * message when the value is stale for the current contents, or `null` when the
 * value can be handed to Cline unchanged.
 *
 * This only *validates*; it never rewrites `insert_line`, so a request that
 * Cline would accept is never turned into a different (wrong-position) insert,
 * and the SDK-error retry path below stays reachable for the classic
 * off-by-one (`maxLine + 1`).
 */
async function recoveryForStaleInsertLine(
  resolvedPath: string,
  displayPath: string,
  insertLine: number,
): Promise<string | null> {
  const content = await readFile(resolvedPath, "utf8").catch(() => null);
  if (content === null) {
    // Directory, or file removed between access() and read(): let Cline own the
    // resulting error instead of throwing out of the executor.
    return null;
  }
  const maxLine = maxInsertLineForFile(content);
  if (isInsertLineHandledByCline(insertLine, maxLine)) {
    return null;
  }
  return invalidInsertLineRecoveryMessage(displayPath, insertLine, maxLine);
}

function recoveryFromInvalidInsertLineToolError(
  displayPath: string,
  toolError: string,
): string | null {
  const parsed = parseInvalidInsertLineError(toolError);
  if (!parsed) {
    return null;
  }
  return invalidInsertLineRecoveryMessage(
    displayPath,
    parsed.attempted,
    parsed.maxLine,
  );
}

/**
 * Computes the retry line for Cline's classic EOF off-by-one (`maxLine + 1`).
 *
 * Cline's `appendAtEofLine` is its `maxLine`, which inserts after the trailing
 * empty element on files that already end with a newline, adding a stray blank
 * line. The no-blank-line boundary for those files is `maxLine - 1`, which is
 * what `FILE_EDIT_SYSTEM_HINT` and the recovery message recommend
 * (`line_count + 1`). `maxLine - 1` is always `>= 1`, so the retry stays valid.
 */
function insertLineRetryAtEof(
  toolError: string,
  content: string | null,
): number | null {
  const parsed = parseInvalidInsertLineError(toolError);
  if (!parsed) {
    return null;
  }
  if (parsed.attempted !== parsed.maxLine + 1) {
    return null;
  }
  if (content !== null && /\r?\n$/.test(content)) {
    return parsed.maxLine - 1;
  }
  return parsed.appendAtEofLine;
}

/**
 * Workspace-aware wrapper around Cline’s default `editor` executor.
 *
 * - **Paths** — resolve `read_files` / `editor` paths against the checkout root.
 * - **Missing `old_text`** — clearer errors (`editor-old-text-recovery.ts`).
 * - **`insert_line` bounds** — Cline-derived bound validation + recovery
 *   (`editor-insert-line-recovery.ts`).
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

    if (fileExists && hasInsertLine) {
      const recovery = await recoveryForStaleInsertLine(
        resolvedPath,
        displayPath,
        normalizedInput.insert_line as number,
      );
      if (recovery) {
        return editorFailureResult(displayPath, recovery);
      }
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

        if (isInvalidInsertLineEditorError(toolError)) {
          // Cline validates before writing, so the file is unchanged here; the
          // read only decides the retry boundary for trailing-newline files.
          const content = await readFile(resolvedPath, "utf8").catch(
            () => null,
          );
          const retryLine = insertLineRetryAtEof(toolError, content);
          if (retryLine !== null) {
            const retryResult = await inner(
              { ...normalizedInput, insert_line: retryLine },
              cwd,
              context,
            );
            const retryError = editorResultError(retryResult);
            if (!retryError) {
              return retryResult;
            }
          }

          const recovery = recoveryFromInvalidInsertLineToolError(
            displayPath,
            toolError,
          );
          if (recovery) {
            if (result && typeof result === "object") {
              return { ...result, error: recovery };
            }
            return editorFailureResult(displayPath, recovery);
          }
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
