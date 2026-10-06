/**
 * Workspace-scoped `apply_patch` executor.
 *
 * ## Problem
 *
 * Cline advertises the Cursor-native `apply_patch` tool (it is a builtin write
 * tool, auto-approved for write phases, and summarised in `gha-log.ts`) and
 * force-enables it while disabling `editor` for some model families
 * (codex / GPT presets). The GHA runtime only registered `readFile`, `editor`
 * and `bash`, so the SDK’s own apply-patch executor — not our workspace-scoped
 * shims — resolved those calls, and models that expected the Cursor-native tool
 * hit friction (“the requested apply_patch command is not installed in this
 * runner”, foldio-app#2704), wasting turns.
 *
 * ## What we do in this repo
 *
 * - Register a thin wrapper around Cline’s default `applyPatch` executor
 *   (`createDefaultExecutors().applyPatch`), mirroring the `editor` /
 *   `readFile` shims. Cline builds its tool list as “`editor` when enabled,
 *   otherwise `apply_patch` when enabled *and* an `applyPatch` executor is
 *   present” (`@cline/core` `createDefaultTools`), and its default
 *   model-tool routing (`codex-and-gpt-use-apply-patch`,
 *   `openai-native-use-apply-patch`) enables `apply_patch` while disabling
 *   `editor` for those act runs. Executors supplied via
 *   `capabilities.toolExecutors` override the SDK defaults, so this wrapper —
 *   not the raw SDK executor — handles the patch on exactly those runs.
 * - Force the GHA checkout (`workspaceRoot`) as the executor `cwd` so relative
 *   patch paths always resolve against the checkout. Cline already calls the
 *   executor with the tool’s configured `cwd` (`t.cwd ?? process.cwd()`, which
 *   `runtime.ts` sets to the checkout), so today this is a no-op; we keep it
 *   deliberately so the shim cannot escape the checkout if that ever changes.
 * - Resolve every patch-header path through `resolveWorkspaceFilePath`, the
 *   shared workspace-containment helper used by the `editor` and `readFile`
 *   shims. That maps both the `/workspace/…` habit (Cursor/Docker) and a bare
 *   leading-slash path (`/src/a.ts`, which Cline would otherwise treat as
 *   filesystem root) into the checkout, and emits the result workspace-relative
 *   so Cline’s `restrictToCwd` guard still applies.
 * - Record `runtime/tool_error` run friction (sibling `editor` shim category),
 *   including the patched paths as `context`, when patch application throws.
 *
 * ## Revisit when
 *
 * `@cline/sdk` drops or renames `createDefaultExecutors().applyPatch`; the
 * constructor guard surfaces a clear error at session start if it does.
 */

import path from "node:path";
import { loadClineSdk } from "../cline.js";
import { getActiveRunFrictionCollector } from "../run-friction.js";
import { resolveWorkspaceFilePath } from "./resolve-workspace-path.js";

/** Cline patch headers that carry a file path (`@cline/core` `PATCH_MARKERS`). */
const PATCH_HEADER_PATTERN =
  /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*)$/gm;

/** Trimmed paths from all patch headers; used for run-friction context. */
export function listPatchHeaderPaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const match of patchText.matchAll(PATCH_HEADER_PATTERN)) {
    const candidate = match[2]?.trim();
    if (candidate) {
      paths.push(candidate);
    }
  }
  return paths;
}

/**
 * Rewrite Cline apply_patch header paths so they stay inside the checkout, and
 * emit them workspace-relative (Cline resolves those against the forced cwd and
 * keeps its `restrictToCwd` guard).
 *
 * Unlike a plain `/workspace/` strip, this also catches a bare leading-slash
 * habit such as `/src/a.ts`, which Cline would otherwise treat as an absolute
 * filesystem-root path. Paths that cannot be mapped into the workspace (for
 * example `../outside.ts`) are left untouched so Cline reports the failure.
 */
export function normalizePatchHeaderPaths(
  patchText: string,
  workspaceRoot: string,
): string {
  const root = path.resolve(workspaceRoot);
  return patchText.replace(
    PATCH_HEADER_PATTERN,
    (line, prefix: string, filePath: string) => {
      const trimmed = filePath.trim();
      if (!trimmed) {
        return line;
      }
      let relativePath: string;
      try {
        relativePath = path.relative(
          root,
          resolveWorkspaceFilePath(root, trimmed),
        );
      } catch {
        return line;
      }
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
      input: normalizePatchHeaderPaths(input.input, workspaceRoot),
    };

    try {
      // Deliberately ignore the cwd Cline passes (the tool's configured cwd,
      // which `runtime.ts` already points at the checkout) and force the
      // workspace root instead, so the patch can never resolve elsewhere.
      return await inner(normalizedInput, workspaceRoot, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const headerPaths = listPatchHeaderPaths(input.input);
      getActiveRunFrictionCollector()?.record({
        source: "runtime",
        category: "tool_error",
        summary: `apply_patch: ${message}`,
        context: headerPaths.length > 0 ? headerPaths.join(", ") : undefined,
        mitigation:
          "Retry the patch with workspace-relative paths in the *** Add File: / *** Update File: / *** Delete File: / *** Move to: headers; if it still fails, use bash (git mv / patch) or the editor tool when that model has it enabled.",
      });
      throw error;
    }
  };
}
