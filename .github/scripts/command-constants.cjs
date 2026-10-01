/**
 * Shared constants for slash-command validation.
 *
 * Used by both the TypeScript runtime (packages/agent-pipeline/src/commands/resolve.ts)
 * and the GitHub Actions dispatch script (.github/scripts/parse-agent-commands.cjs).
 *
 * Keep this file plain CJS so it can be required without any build step.
 */

const SLASH_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = new Set(["fix"]);

const BUILTIN_PHASES = [
  "plan",
  "implement",
  "yolo",
  "ci-fix",
  "review-fix",
  "ask",
  "code-review",
];

module.exports = { SLASH_TOKEN, RESERVED, BUILTIN_PHASES };
