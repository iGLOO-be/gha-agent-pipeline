/**
 * Cline `editor` on an **existing** file without `old_text` (or `insert_line`).
 *
 * Separate from the 6000-char limit — see `editor-size-recovery.ts` for that.
 * Matches @cline/core until cline/cline#13970 ships in npm; we throw a clearer
 * message from `workspace-scoped-editor.ts` when this error is raised.
 */
export function isMissingOldTextEditorError(message: string): boolean {
  return (
    message.includes("old_text") &&
    message.includes("required when editing an existing file")
  );
}

export function missingOldTextRecoveryMessage(
  filePath: string,
  oldText: string | null | undefined,
): string {
  return `${filePath} already exists, but \`old_text\` was ${
    oldText === null ? "null" : "omitted"
  }. To edit an existing file, set \`old_text\` to the exact text in the file that \`new_text\` should replace (read the file first if needed). To insert instead, provide \`insert_line\`. Do not re-send this call unchanged.`;
}
