/**
 * Workspace-scoped `apply_patch` executor.
 *
 * ## Problem
 *
 * Cline advertises the Cursor-native `apply_patch` tool (it is a builtin write
 * tool, auto-approved for write phases, and summarised in `gha-log.ts`) and
 * force-enables it while disabling `editor` for some model families
 * (codex / GPT presets). The GHA runtime only registered `readFile`, `editor`
 * and `bash`, so those calls failed with “the requested apply_patch command is
 * not installed in this runner” (foldio-app#2704), wasting turns.
 *
 * ## What we do in this repo
 *
 * - Register a thin wrapper around Cline’s default `applyPatch` executor
 *   (`createDefaultExecutors().applyPatch`), mirroring the `editor` /
 *   `readFile` shims.
 * - Force the GHA checkout (`workspaceRoot`) as the executor `cwd` so relative
 *   patch paths always resolve against the checkout.
 * - Normalise model habit `/workspace/…` patch headers (Cursor/Docker) to
 *   cwd-relative paths, because Cline treats a leading `/` as a literal
 *   filesystem-root path.
 * - Record `runtime/tool_limit` run friction with an `editor` fallback hint when
 *   patch application throws.
 *
 * ## Revisit when
 *
 * `@cline/sdk` drops or renames `createDefaultExecutors().applyPatch`; the
 * constructor guard surfaces a clear error at session start if it does.
 */

import { loadClineSdk } from "../cline.js";
import { getActiveRunFrictionCollector } from "../run-friction.js";
import { stripWorkspaceAliasPrefix } from "./resolve-workspace-path.js";

/** Cline patch headers that carry a file path (`@cline/core` `PATCH_MARKERS`). */
const PATCH_HEADER_PATTERN =
  /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*)$/gm;

/**
 * Rewrite `/workspace/…` model aliases in Cline apply_patch headers to
 * cwd-relative paths. Other paths (relative or genuinely absolute) are left
 * untouched.
 */
export function normalizePatchWorkspaceAliases(patchText: string): string {
  return patchText.replace(
    PATCH_HEADER_PATTERN,
    (line, prefix: string, filePath: string) => {
      const trimmed = filePath.trim();
      const stripped = stripWorkspaceAliasPrefix(trimmed);
      if (stripped === trimmed) {
        return line;
      }
      // stripWorkspaceAliasPrefix turns `/workspace/foo` into `/foo`, which
      // Cline would still treat as an absolute path. Drop the leading slash so
      // the file resolves under the forced workspace cwd instead.
      const relativePath = stripped.replace(/^\/+/, "");
      return relativePath ? `${prefix}${relativePath}` : line;
    },
  );
}

export async function createWorkspaceScopedApplyPatchExecutor(
  workspaceRoot: string,
) {
  const { createDefaultExecutors } = await loadClineSdk();
  const inner = createDefaultExecutors().applyPatch;
  if (!inner) {
    throw new Error("Cline default applyPatch executor is unavailable");
  }

  type ApplyPatchRequest = Parameters<typeof inner>[0];
  type AgentToolContext = Parameters<typeof inner>[2];

  return async (
    input: ApplyPatchRequest,
    _cwd: string,
    context: AgentToolContext,
  ) => {
    const normalizedInput = {
      ...input,
      input: normalizePatchWorkspaceAliases(input.input),
    };

    try {
      return await inner(normalizedInput, workspaceRoot, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getActiveRunFrictionCollector()?.record({
        source: "runtime",
        category: "tool_limit",
        summary: `apply_patch: ${message}`,
        mitigation:
          "Use the editor tool instead (workspace-relative path, exact old_text/new_text).",
      });
      throw error;
    }
  };
}
