import { loadClineSdk } from "../cline.js";
import { resolveWorkspaceFilePath } from "./resolve-workspace-path.js";

/**
 * Override Cline's built-in read_files executor so paths resolve against the
 * GitHub Actions checkout (same approach as cline/cline#12558 for VS Code).
 */
export async function createWorkspaceScopedFileReadExecutor(
  workspaceRoot: string,
) {
  const { createDefaultExecutors } = await loadClineSdk();
  const inner = createDefaultExecutors().readFile;
  if (!inner) {
    throw new Error("Cline default readFile executor is unavailable");
  }

  type ReadFileRequest = Parameters<typeof inner>[0];
  type AgentToolContext = Parameters<typeof inner>[1];

  return async (request: ReadFileRequest, context: AgentToolContext) => {
    const resolvedPath = resolveWorkspaceFilePath(workspaceRoot, request.path);
    return inner({ ...request, path: resolvedPath }, context);
  };
}
