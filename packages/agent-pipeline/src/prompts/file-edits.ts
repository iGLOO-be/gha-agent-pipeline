/**
 * Shown in phase system prompts. Keep in sync with Cline’s editor guard and with
 * `cline/editor-size-recovery.ts` (harness bypass for oversized **new** files).
 */
export const CLINE_EDITOR_ARG_CHAR_LIMIT = 6000;

export const FILE_EDIT_SYSTEM_HINT = `File changes:
- Prefer apply_patch for edits to existing files and for new files longer than a few dozen lines (especially tests). Patch headers (\`*** Add File:\` / \`*** Update File:\` / \`*** Delete File:\` / \`*** Move to:\`) are resolved against the checkout root: use workspace-relative paths, and do not prefix them with /workspace/ (any other leading-slash path is mapped into the checkout too, but relative is safest).
- Cline editor rejects any single old_text or new_text over ${CLINE_EDITOR_ARG_CHAR_LIMIT} characters with "Editor input too large". Never send a whole large file in one editor call; split into multiple editor calls (each argument under ${CLINE_EDITOR_ARG_CHAR_LIMIT} chars), build the file incrementally with insert_line, or use apply_patch.
- On an existing file, editor requires old_text: set it to the exact substring to replace (read the file first) or use insert_line; never call editor with only new_text on an existing file.`;
