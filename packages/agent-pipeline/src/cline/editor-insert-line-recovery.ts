/**
 * Cline `editor` bounds `insert_line` on existing files.
 *
 * The installed `@cline/core` implementation does
 * `content.split(/\r\n|\n/).length + 1` and rejects anything outside
 * `1..max`, where `max === newlineCount + 2`. The no-blank-line EOF append is
 * `newlineCount + 1` (`line_count + 1` relative to what `read_files` shows,
 * which omits the trailing empty line). Cline's `max` also appends at EOF, but
 * adds a blank line when the file already ends with a newline. Models
 * still sometimes pass stale line numbers after incremental inserts. See
 * `workspace-scoped-editor.ts`.
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

/**
 * Cline's `insert_line` bound for a file: `newlineCount + 2`
 * (`content.split(/\r\n|\n/).length + 1`). This is the largest accepted value;
 * it is also Cline's `appendAtEofLine`, which appends at EOF but adds a blank
 * line when the file already ends with a newline. Returns 2 for an empty file
 * (Cline accepts `1..2` there).
 */
export function maxInsertLineForFile(content: string): number {
  let newlines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      newlines++;
    }
  }
  return newlines + 2;
}

/**
 * Whether `insert_line` can be handed to Cline (or recovered by the SDK-error
 * retry) rather than short-circuited with a recovery message. `insert_line` is
 * never rewritten.
 *
 * In-range values (`<= maxLine`) always pass through, so a valid EOF append is
 * never rewritten. `maxLine + 1` (the classic off-by-one) also passes through:
 * Cline rejects it with its own numbers and the error-driven retry in
 * `workspace-scoped-editor.ts` recovers the EOF position. Anything higher is a
 * stale value.
 */
export function isInsertLineHandledByCline(
  insertLine: number,
  maxLine: number,
): boolean {
  return insertLine <= maxLine + 1;
}

export function invalidInsertLineRecoveryMessage(
  filePath: string,
  attempted: number,
  maxLine: number,
): string {
  return `${filePath}: \`insert_line\` ${attempted} is out of range. Valid boundary lines are 1–${maxLine} on the current file (re-read the file before inserting). To append at EOF, use the line after the last one you read (\`line_count + 1\`); never reuse a stale line number after earlier inserts.`;
}
