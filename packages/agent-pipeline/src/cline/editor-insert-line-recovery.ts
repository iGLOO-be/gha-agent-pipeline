/**
 * Cline `editor` rejects `insert_line` outside `1..lineCount` on existing files.
 * Models often pass `lineCount + 1` when appending at EOF, or stale line numbers
 * after incremental inserts. See `workspace-scoped-editor.ts`.
 */

const INVALID_INSERT_LINE_RE =
  /Invalid insert_line:\s*(\d+)\.\s*insert_line must be a positive one-based boundary line in the range 1-(\d+)\.\s*Use (\d+) to append at EOF\./;

export function isInvalidInsertLineEditorError(message: string): boolean {
  return (
    message.includes("Invalid insert_line") &&
    message.includes("insert_line must")
  );
}

export type ParsedInvalidInsertLineError = {
  attempted: number;
  maxLine: number;
  appendAtEofLine: number;
};

export function parseInvalidInsertLineError(
  message: string,
): ParsedInvalidInsertLineError | null {
  const match = message.match(INVALID_INSERT_LINE_RE);
  if (!match) {
    return null;
  }
  return {
    attempted: Number.parseInt(match[1], 10),
    maxLine: Number.parseInt(match[2], 10),
    appendAtEofLine: Number.parseInt(match[3], 10),
  };
}

/** Line count for Cline `insert_line` bounds (1..count inclusive for EOF). */
export function countEditorFileLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      newlines++;
    }
  }
  if (content.endsWith("\n")) {
    return newlines;
  }
  return newlines + 1;
}

/**
 * Returns corrected `insert_line` when the only issue is EOF off-by-one
 * (`lineCount + 1`). Otherwise `null` (caller should surface recovery).
 */
export function normalizeInsertLineForFile(
  insertLine: number,
  lineCount: number,
): number | null {
  if (insertLine <= lineCount) {
    return insertLine;
  }
  if (lineCount > 0 && insertLine === lineCount + 1) {
    return lineCount;
  }
  return null;
}

export function invalidInsertLineRecoveryMessage(
  filePath: string,
  attempted: number,
  maxLine: number,
): string {
  return `${filePath}: \`insert_line\` ${attempted} is out of range. Valid boundary lines are 1–${maxLine} on the current file (re-read the file before inserting). Use \`insert_line: ${maxLine}\` to append at EOF. Do not reuse a stale line number after earlier inserts.`;
}
