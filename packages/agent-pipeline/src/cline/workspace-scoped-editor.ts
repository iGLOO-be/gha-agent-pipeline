import { loadClineSdk } from "../cline.js";
import {
  isMissingOldTextEditorError,
  missingOldTextRecoveryMessage,
} from "./editor-old-text-recovery.js";
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

/**
 * Override Cline's built-in editor executor so paths resolve against the
 * checkout root and missing `old_text` errors include recovery guidance
 * (workaround for @cline/sdk@0.0.82; upstream fix: cline/cline#13970).
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
    const resolvedPath = resolveWorkspaceFilePath(workspaceRoot, input.path);
    const normalizedInput = { ...input, path: resolvedPath };

    try {
      const result = await inner(normalizedInput, cwd, context);
      const toolError = editorResultError(result);
      if (toolError) {
        getActiveRunFrictionCollector()?.recordRuntimeToolError(
          "editor",
          toolError,
          resolvedPath,
        );
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getActiveRunFrictionCollector()?.recordRuntimeToolError(
        "editor",
        message,
        resolvedPath,
      );
      if (isMissingOldTextEditorError(message)) {
        throw new Error(
          missingOldTextRecoveryMessage(resolvedPath, input.old_text),
        );
      }
      throw error;
    }
  };
}
