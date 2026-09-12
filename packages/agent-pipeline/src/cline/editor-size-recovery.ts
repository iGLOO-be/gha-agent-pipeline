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

/** New file via editor: no old_text, no insert_line — common for agent-phase.yml-style creates. */
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
