import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dispatchWorkflowPath = join(repoRoot, ".github/workflows/dispatch.yml");

const AWAIT_CALL_WHITELIST = new Set([
  "fetch",
  "require",
  "github",
  "core",
  "context",
]);

function extractGithubScriptInlineScript(yaml: string): string {
  const marker = "uses: actions/github-script@v7";
  const stepIdx = yaml.indexOf(marker);
  if (stepIdx === -1) {
    throw new Error("github-script step not found in dispatch workflow");
  }
  const scriptIdx = yaml.indexOf("script: |", stepIdx);
  if (scriptIdx === -1) {
    throw new Error("script block not found in dispatch workflow");
  }
  const after = yaml.slice(scriptIdx + "script: |".length);
  const lines: string[] = [];
  for (const line of after.split("\n")) {
    if (line.length > 0 && !line.startsWith("            ")) {
      break;
    }
    lines.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  return lines.join("\n").trimEnd();
}

function collectDefinedFunctions(script: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /\basync\s+function\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of script.matchAll(pattern)) {
      names.add(match[1]);
    }
  }
  return names;
}

function collectAwaitCalls(script: string): string[] {
  const calls: string[] = [];
  const pattern = /\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of script.matchAll(pattern)) {
    calls.push(match[1]);
  }
  return calls;
}

describe("dispatch workflow inline script", () => {
  it("only awaits functions defined in the same script (or github-script globals)", () => {
    const yaml = readFileSync(dispatchWorkflowPath, "utf8");
    const script = extractGithubScriptInlineScript(yaml);
    const defined = collectDefinedFunctions(script);
    const awaitCalls = collectAwaitCalls(script);
    const undefinedCalls = [
      ...new Set(
        awaitCalls.filter(
          (name) => !defined.has(name) && !AWAIT_CALL_WHITELIST.has(name),
        ),
      ),
    ];
    expect(undefinedCalls).toEqual([]);
  });
});
