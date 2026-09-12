import path from "node:path";

function assertWithinWorkspace(
  workspaceRoot: string,
  resolved: string,
  inputPath: string,
): void {
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path must stay within the workspace: ${inputPath}`);
  }
}

/**
 * Resolve read_files / editor paths against the checkout root.
 *
 * Cline's default reader treats paths like `/README.md` as filesystem-root
 * absolute paths. Models often intend the repository root instead.
 */
/** Strip model habit `/workspace/...` (Cursor/Docker) so files resolve under the checkout. */
export function stripWorkspaceAliasPrefix(inputPath: string): string {
  return inputPath.trim().replace(/^\/workspace\/+/i, "/");
}

export function resolveWorkspaceFilePath(
  workspaceRoot: string,
  inputPath: string,
): string {
  const root = path.resolve(workspaceRoot);
  const trimmed = stripWorkspaceAliasPrefix(inputPath);
  if (!trimmed) {
    throw new Error("Empty file path");
  }

  const normalized = path.normalize(trimmed);

  if (!path.isAbsolute(normalized)) {
    const resolved = path.resolve(root, normalized);
    assertWithinWorkspace(root, resolved, trimmed);
    return resolved;
  }

  const relativeToRoot = path.relative(root, normalized);
  if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
    return normalized;
  }

  const workspaceRelative = trimmed.replace(/^\/+/, "");
  if (!workspaceRelative) {
    throw new Error(
      `Path must reference a file in the workspace: ${inputPath}`,
    );
  }

  const resolved = path.resolve(root, workspaceRelative);
  assertWithinWorkspace(root, resolved, trimmed);
  return resolved;
}
