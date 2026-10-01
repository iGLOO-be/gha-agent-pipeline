import { describe, expect, it } from "vitest";
import { agentConfigSchema, loadAgentConfig } from "../config.js";
import {
  listCommands,
  resolveCommand,
  resolveCommandBySlash,
  validateCommandRegistry,
} from "./resolve.js";
import { buildCommandSystemPrompt } from "./prompt.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveCommand", () => {
  it("returns built-in defaults when commands section is absent", () => {
    const config = agentConfigSchema.parse({ version: 1 });
    const resolved = resolveCommand("plan", config);
    expect(resolved.extends).toBe("plan");
    expect(resolved.slash).toBe("plan");
    expect(resolved.enabled).toBe(true);
  });

  it("merges custom command extending implement", () => {
    const config = agentConfigSchema.parse({
      version: 1,
      commands: {
        hardening: {
          extends: "implement",
          slash: "hardening",
          prompts: {
            append_instructions: "Run a short threat model first.",
          },
          tools: { write: true },
        },
      },
    });
    validateCommandRegistry(config);
    const resolved = resolveCommand("hardening", config);
    expect(resolved.extends).toBe("implement");
    expect(resolved.prompts.append_instructions).toContain("threat model");
    const prompt = buildCommandSystemPrompt(resolved, config);
    expect(prompt).toContain("threat model");
    expect(prompt).toContain("Do not commit, push, or open a PR yourself");
  });

  it("finds command by slash", () => {
    const config = agentConfigSchema.parse({
      version: 1,
      commands: {
        audit: { extends: "ask", slash: "audit" },
      },
    });
    const resolved = resolveCommandBySlash("audit", config);
    expect(resolved?.id).toBe("audit");
  });

  it("lists built-ins and customs", () => {
    const config = agentConfigSchema.parse({
      version: 1,
      commands: {
        audit: {
          extends: "ask",
          slash: "audit",
          description: "Read-only audit",
        },
      },
    });
    const entries = listCommands(config);
    expect(entries.some((e) => e.id === "plan")).toBe(true);
    expect(entries.some((e) => e.id === "audit")).toBe(true);
  });

  it("loads commands from YAML file via loadAgentConfig", () => {
    const dir = join(tmpdir(), `agent-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "agent.config.yml");
    writeFileSync(
      path,
      [
        "version: 1",
        "commands:",
        "  spike:",
        "    extends: yolo",
        "    slash: spike",
      ].join("\n"),
    );
    try {
      const config = loadAgentConfig(path);
      expect(resolveCommand("spike", config).extends).toBe("yolo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parse-agent-commands.js", () => {
  it("parses custom commands from YAML for dispatch", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const {
      parseAgentCommandsFromYaml,
      resolveSlashCommand,
    } = require("../../../../.github/scripts/parse-agent-commands.cjs");

    const yaml = [
      "version: 1",
      "commands:",
      "  hardening:",
      "    extends: implement",
      "    slash: hardening",
      "    context:",
      "      targets:",
      "        - issue",
    ].join("\n");

    const commands = parseAgentCommandsFromYaml(yaml);
    const match = resolveSlashCommand("/agent hardening extra notes", commands);
    expect(match?.command.id).toBe("hardening");
    expect(match?.command.extends).toBe("implement");
    expect(match?.args).toBe("extra notes");
  });
});
describe("BUILTIN_PHASES parity", () => {
  it("CJS BUILTIN_PHASES matches TS BUILTIN_AGENT_PHASES", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const {
      BUILTIN_PHASES,
    } = require("../../../../.github/scripts/command-constants.cjs");
    const { BUILTIN_AGENT_PHASES } = await import("./types.js");
    expect([...BUILTIN_PHASES].sort()).toEqual(
      [...BUILTIN_AGENT_PHASES].sort(),
    );
  });
});
