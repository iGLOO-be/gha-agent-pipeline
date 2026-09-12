/** Shared hint so models stop using `/workspace/...` (not the GHA checkout root). */
export function workspacePathSystemHint(repoRoot: string): string {
  return `Repository root (cwd for read_files, list_files, editor, apply_patch): ${repoRoot}
Use paths relative to that root (e.g. tools/agent/runtime.ts, .github/workflows/ci.yml).
Do not prefix paths with /workspace/ — that directory does not exist here. Paths like /workspace/README.md will fail unless rewritten.`;
}
