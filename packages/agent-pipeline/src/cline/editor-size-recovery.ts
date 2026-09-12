/**
 * Cline `editor` tool — 6000-character argument limit
 *
 * ## Problem
 *
 * `@cline/sdk` (via `@cline/core`) rejects any `editor` call where `old_text` or
 * `new_text` exceeds 6000 characters. The tool returns `success: false` and the
 * error string `Editor input too large: … exceeding the recommended limit of 6000`
 * **without writing the file**. The model often retries the same oversized payload,
 * which wastes tokens and shows up as failed tool calls in GHA logs.
 *
 * Prompt hints (`FILE_EDIT_SYSTEM_HINT` in `prompts/file-edits.ts`) reduce but do
 * not eliminate this: implement runs still hit it when creating whole files in one
 * call (e.g. `.github/workflows/agent-phase.yml` at ~6.8k chars on issue #8).
 *
 * ## What we do in this repo
 *
 * 1. **New files** — `workspace-scoped-editor.ts` detects create-style calls
 *    (path absent, no `old_text` / `insert_line`) with oversized `new_text` and
 *    writes via Node `fs` instead of calling Cline’s executor. The model still sees
 *    a successful `editor` result.
 * 2. **Existing files** — no safe automatic rewrite; return an expanded error via
 *    `oversizedEditorRecoveryMessage` so the model is steered toward `apply_patch` or
 *    smaller `editor` chunks.
 * 3. **Observability** — remaining limit hits are recorded as `tool_limit` run
 *    friction (`run-friction.ts`) on phase comments / step summaries.
 *
 * Related: missing `old_text` on existing files is handled separately in
 * `editor-old-text-recovery.ts` (cline/cline#13970).
 *
 * Revisit when upgrading `@cline/sdk` if upstream relaxes or removes the guard
 * (see cline/cline#13263).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLINE_EDITOR_ARG_CHAR_LIMIT } from "../prompts/file-edits.js";

export type EditorLikeInput = {
  path: string;
  new_text: string;
  old_text?: string | null;
  insert_line?: number | null;
};

export function isEditorInputTooLargeError(message: string): boolean {
  return message.includes("Editor input too large");
}

export function editorArgLengths(input: EditorLikeInput): {
  oldTextLength: number;
  newTextLength: number;
} {
  const oldTextLength =
    typeof input.old_text === "string" ? input.old_text.length : 0;
  return { oldTextLength, newTextLength: input.new_text.length };
}

export function exceedsEditorArgLimit(
  input: EditorLikeInput,
  limit = CLINE_EDITOR_ARG_CHAR_LIMIT,
): boolean {
  const { oldTextLength, newTextLength } = editorArgLengths(input);
  return oldTextLength > limit || newTextLength > limit;
}

/**
 * Create-via-editor pattern: entire file content in `new_text` only.
 * Typical when the model adds a new workflow or test file in one shot.
 */
export function isOversizedNewFileEditorWrite(
  input: EditorLikeInput,
  fileExists: boolean,
  limit = CLINE_EDITOR_ARG_CHAR_LIMIT,
): boolean {
  if (fileExists) {
    return false;
  }
  if (input.insert_line !== undefined && input.insert_line !== null) {
    return false;
  }
  const hasOldText =
    typeof input.old_text === "string" && input.old_text.length > 0;
  if (hasOldText) {
    return false;
  }
  return input.new_text.length > limit;
}

export function oversizedEditorRecoveryMessage(
  displayPath: string,
  input: EditorLikeInput,
  limit = CLINE_EDITOR_ARG_CHAR_LIMIT,
): string {
  const { oldTextLength, newTextLength } = editorArgLengths(input);
  const parts = [
    `${displayPath}: Cline editor rejects old_text or new_text over ${limit} characters ("Editor input too large").`,
  ];
  if (oldTextLength > limit) {
    parts.push(
      `old_text is ${oldTextLength} chars — use apply_patch or replace a smaller exact substring.`,
    );
  }
  if (newTextLength > limit) {
    parts.push(
      `new_text is ${newTextLength} chars — use apply_patch, split into multiple editor calls (each argument under ${limit} chars), or insert_line in steps.`,
    );
  }
  parts.push("Do not re-send this call unchanged.");
  return parts.join(" ");
}

/** Harness write path when Cline would reject the payload but content is a new file. */
export async function writeNewFileBypassingEditorLimit(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

export function editorBypassSuccessResult(
  displayPath: string,
  byteLength: number,
  limit = CLINE_EDITOR_ARG_CHAR_LIMIT,
): {
  success: true;
  query: string;
  result: string;
  error: string;
} {
  return {
    success: true,
    query: `edit:${displayPath}`,
    result: `Wrote ${byteLength} characters to ${displayPath} (agent-pipeline bypass: new_text exceeded Cline's ${limit}-character editor argument limit).`,
    error: "",
  };
}
