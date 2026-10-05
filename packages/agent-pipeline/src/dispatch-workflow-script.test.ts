import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  formatUnknownAgentCommandReply,
  unknownCommandReason,
} = require("../../../.github/scripts/format-unknown-agent-command.cjs");
const { RESERVED } = require("../../../.github/scripts/command-constants.cjs");

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
  it("checks out slash-parser scripts from the reusable workflow repo", () => {
    const yaml = readFileSync(dispatchWorkflowPath, "utf8");
    expect(yaml).toContain("Checkout dispatch scripts (library)");
    expect(yaml).toContain("repository: ${{ job.workflow_repository }}");
    expect(yaml).toContain("ref: ${{ job.workflow_sha }}");
    expect(yaml).toContain("path: _gha-agent-pipeline-dispatch");
    expect(yaml).toContain(
      "require('./_gha-agent-pipeline-dispatch/.github/scripts/parse-agent-commands.cjs')",
    );
    expect(yaml).not.toContain(
      "require('./.github/scripts/parse-agent-commands.cjs')",
    );
  });

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

function extractFunction(script: string, name: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex(
    (line) =>
      line.startsWith(`async function ${name}(`) ||
      line.startsWith(`function ${name}(`),
  );
  if (start === -1) {
    throw new Error(`function ${name} not found in dispatch script`);
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      return lines.slice(start, i + 1).join("\n");
    }
  }
  throw new Error(`closing brace for ${name} not found in dispatch script`);
}

/**
 * Evaluates `replyUnknownAgentCommand` (plus the reserved-token helper it
 * depends on) straight from `dispatch.yml` against a stubbed `github` client.
 */
function loadReplyUnknownAgentCommand() {
  const yaml = readFileSync(dispatchWorkflowPath, "utf8");
  const script = extractGithubScriptInlineScript(yaml);
  const source = [
    extractFunction(script, "reservedSlashTokensFor"),
    extractFunction(script, "replyUnknownAgentCommand"),
  ].join("\n");
  const factory = new Function(
    "github",
    "owner",
    "repo",
    "formatUnknownAgentCommandReply",
    "unknownCommandReason",
    "RESERVED",
    `${source}\nreturn replyUnknownAgentCommand;`,
  );
  const calls: Array<{ issue_number: number; body: string }> = [];
  const github = {
    rest: {
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          calls.push(args);
        },
      },
    },
  };
  const reply = factory(
    github,
    "owner",
    "repo",
    formatUnknownAgentCommandReply,
    unknownCommandReason,
    RESERVED,
  );
  return { reply, calls };
}

describe("dispatch replyUnknownAgentCommand", () => {
  it("posts exactly one comment when a slash cannot be dispatched", async () => {
    const { reply, calls } = loadReplyUnknownAgentCommand();

    await reply({
      issueNumber: 7,
      slash: "review",
      target: "pr",
      commands: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].issue_number).toBe(7);
    expect(calls[0].body).toContain("`/agent review` was not executed");
  });

  it("sanitizes the echoed token and reports disabled commands", async () => {
    const { reply, calls } = loadReplyUnknownAgentCommand();

    await reply({
      issueNumber: 9,
      slash: "`@everyone`",
      target: "issue",
      commands: [],
    });
    await reply({
      issueNumber: 9,
      slash: "audit",
      target: "issue",
      commands: [{ slash: "audit", enabled: false, targets: ["issue"] }],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain("`/agent @everyone` was not executed");
    expect(calls[0].body).not.toContain("`@everyone`");
    expect(calls[1].body).toContain("disabled in `agent.config.yml`");
  });
});
