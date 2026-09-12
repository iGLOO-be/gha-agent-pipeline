import { loadClineSdk } from "../cline.js";
import {
  isMissingOldTextEditorError,
  missingOldTextRecoveryMessage,
} from "./editor-old-text-recovery.js";
import { resolveWorkspaceFilePath } from "./resolve-workspace-path.js";

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
      return await inner(normalizedInput, cwd, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingOldTextEditorError(message)) {
        throw new Error(
          missingOldTextRecoveryMessage(resolvedPath, input.old_text),
        );
      }
      throw error;
    }
  };
}
