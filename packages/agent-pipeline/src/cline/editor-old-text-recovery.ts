/** Matches @cline/core editor executor until cline/cline#13970 ships in npm. */
export function isMissingOldTextEditorError(message: string): boolean {
  return (
    message.includes("`old_text`") &&
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
