import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  collectAvailableSlashTokens,
  findSuggestedSlash,
  formatUnknownAgentCommandReply,
} = require("../../../.github/scripts/format-unknown-agent-command.cjs");
const {
  parseAgentCommandsFromYaml,
} = require("../../../.github/scripts/parse-agent-commands.cjs");

const configYaml = [
  "version: 1",
  "commands:",
  "  config-audit:",
  "    extends: ask",
  "    slash: config-audit",
].join("\n");

function loadCommands() {
  return parseAgentCommandsFromYaml(configYaml);
}

describe("collectAvailableSlashTokens", () => {
  it("lists enabled commands for the target plus reserved tokens", () => {
    const tokens = collectAvailableSlashTokens({
      target: "pr",
      commands: loadCommands(),
      reservedSlashTokens: ["fix"],
    });
    expect(tokens).toContain("code-review");
    expect(tokens).toContain("review-fix");
    expect(tokens).toContain("config-audit");
    expect(tokens).toContain("fix");
    expect(tokens).not.toContain("plan");
  });

  it("excludes PR-only commands and reserved tokens on an issue", () => {
    const tokens = collectAvailableSlashTokens({
      target: "issue",
      commands: loadCommands(),
    });
    expect(tokens).toContain("plan");
    expect(tokens).toContain("config-audit");
    expect(tokens).not.toContain("code-review");
    expect(tokens).not.toContain("review-fix");
    expect(tokens).not.toContain("fix");
  });

  it("skips disabled commands", () => {
    const tokens = collectAvailableSlashTokens({
      target: "issue",
      commands: [
        { slash: "plan", enabled: false, targets: ["issue"] },
        { slash: "audit", enabled: true, targets: ["issue"] },
      ],
    });
    expect(tokens).toEqual(["audit"]);
  });
});

describe("findSuggestedSlash", () => {
  it("suggests code-review for the review alias", () => {
    expect(
      findSuggestedSlash("review", ["review-fix", "ask", "code-review", "fix"]),
    ).toBe("code-review");
  });

  it("suggests the closest command for a typo", () => {
    expect(findSuggestedSlash("implementt", ["plan", "implement"])).toBe(
      "implement",
    );
  });

  it("returns null for unrelated tokens", () => {
    expect(findSuggestedSlash("zzz", ["plan", "implement"])).toBeNull();
  });
});

describe("formatUnknownAgentCommandReply", () => {
  it("posts an explicit reply with a suggestion and the PR commands", () => {
    const body = formatUnknownAgentCommandReply({
      slash: "review",
      target: "pr",
      commands: loadCommands(),
      reservedSlashTokens: ["fix"],
    });
    expect(body).toContain("`/agent review` was not executed");
    expect(body).toContain("unknown command");
    expect(body).toContain("Did you mean `/agent code-review`?");
    expect(body).toContain("**Available commands on this pull request:**");
    expect(body).toContain("`/agent code-review`");
    expect(body).toContain("`/agent fix`");
    expect(body).not.toContain("`/agent plan`");
  });

  it("explains a command that exists but is unavailable on a PR", () => {
    const body = formatUnknownAgentCommandReply({
      slash: "plan",
      target: "pr",
      commands: loadCommands(),
      reservedSlashTokens: ["fix"],
      reason: "wrong-target",
    });
    expect(body).toContain("`/agent plan` was not executed");
    expect(body).toContain("not available on pull request comments");
    expect(body).not.toContain("Did you mean");
    expect(body).toContain("**Available commands on this pull request:**");
    expect(body).toContain("`/agent code-review`");
  });

  it("lists issue commands and omits PR-only ones", () => {
    const body = formatUnknownAgentCommandReply({
      slash: "bogus",
      target: "issue",
      commands: loadCommands(),
    });
    expect(body).toContain("`/agent bogus` was not executed");
    expect(body).toContain("**Available commands on this issue:**");
    expect(body).toContain("`/agent plan`");
    expect(body).toContain("`/agent config-audit`");
    expect(body).not.toContain("`/agent code-review`");
    expect(body).not.toContain("`/agent fix`");
  });

  it("never reacts twice in a single reply", () => {
    const body = formatUnknownAgentCommandReply({
      slash: "nope",
      target: "issue",
      commands: loadCommands(),
    });
    expect(body.match(/was not executed/g)).toHaveLength(1);
  });
});
