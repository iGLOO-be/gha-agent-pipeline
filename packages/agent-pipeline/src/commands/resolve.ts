import type { AgentConfig, AgentPhase } from "../config.js";
import {
  BUILTIN_AGENT_PHASES,
  type CommandOverrideConfig,
  type CommandTarget,
  type ListCommandsEntry,
  type ResolvedCommand,
} from "./types.js";

const SLASH_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_SLASHES = new Set(["fix"]);

function isAgentPhase(value: string): value is AgentPhase {
  return (BUILTIN_AGENT_PHASES as readonly string[]).includes(value);
}

function defaultTargetsForPhase(phase: AgentPhase): CommandTarget[] {
  switch (phase) {
    case "review-fix":
    case "code-review":
      return ["pr"];
    case "ask":
      return ["issue", "pr"];
    default:
      return ["issue"];
  }
}

function phaseWritesByDefault(phase: AgentPhase): boolean {
  return (
    phase === "implement" ||
    phase === "yolo" ||
    phase === "ci-fix" ||
    phase === "review-fix"
  );
}

function mergeOverride(
  id: string,
  override: CommandOverrideConfig | undefined,
): ResolvedCommand {
  const extendsPhase: AgentPhase =
    override?.extends ?? (isAgentPhase(id) ? id : undefined!);
  if (!extendsPhase || !isAgentPhase(extendsPhase)) {
    throw new Error(
      `Command "${id}" must declare extends (one of ${BUILTIN_AGENT_PHASES.join(", ")})`,
    );
  }

  const slash = override?.slash?.trim() || id;
  if (!SLASH_TOKEN.test(slash)) {
    throw new Error(
      `Command "${id}" slash "${slash}" must match ${SLASH_TOKEN.source}`,
    );
  }
  if (RESERVED_SLASHES.has(slash)) {
    throw new Error(`Command "${id}" slash "${slash}" is reserved`);
  }

  return {
    id,
    extends: extendsPhase,
    slash,
    enabled: override?.enabled ?? true,
    description: override?.description,
    model: override?.models?.model,
    prompts: {
      role_description: override?.prompts?.role_description,
      instructions: override?.prompts?.instructions,
      append_instructions: override?.prompts?.append_instructions,
    },
    tools: {
      write: override?.tools?.write,
      github: override?.tools?.github ?? "inherit",
      builtin: override?.tools?.builtin,
    },
    context: {
      targets:
        override?.context?.targets ?? defaultTargetsForPhase(extendsPhase),
      require_plan: override?.context?.require_plan,
    },
    access: override?.access,
    output: override?.output,
    git: override?.git,
  };
}

export function resolveCommand(
  id: string,
  config: AgentConfig,
): ResolvedCommand {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Command id is required");
  }

  const override = config.commands?.[trimmed];
  if (!override && !isAgentPhase(trimmed)) {
    throw new Error(`Unknown command "${trimmed}"`);
  }

  return mergeOverride(trimmed, override);
}

export function resolveCommandBySlash(
  slash: string,
  config: AgentConfig,
): ResolvedCommand | undefined {
  for (const id of listCommandIds(config)) {
    const resolved = resolveCommand(id, config);
    if (resolved.slash === slash) {
      return resolved;
    }
  }
  return undefined;
}

export function listCommandIds(config: AgentConfig): string[] {
  const ids = new Set<string>(BUILTIN_AGENT_PHASES);
  for (const key of Object.keys(config.commands ?? {})) {
    ids.add(key);
  }
  return [...ids].sort();
}

export function listCommands(config: AgentConfig): ListCommandsEntry[] {
  return listCommandIds(config)
    .map((id) => resolveCommand(id, config))
    .filter((cmd) => cmd.enabled)
    .map((cmd) => ({
      id: cmd.id,
      slash: cmd.slash,
      extends: cmd.extends,
      enabled: cmd.enabled,
      description: cmd.description,
      targets: cmd.context.targets,
      access: cmd.access?.author_associations,
    }));
}

export function validateCommandRegistry(config: AgentConfig): void {
  const slashToId = new Map<string, string>();
  for (const id of listCommandIds(config)) {
    const resolved = resolveCommand(id, config);
    const existing = slashToId.get(resolved.slash);
    if (existing && existing !== id) {
      throw new Error(
        `Duplicate slash "/agent ${resolved.slash}" on commands "${existing}" and "${id}"`,
      );
    }
    slashToId.set(resolved.slash, id);
  }
}

export function commandCapabilities(resolved: ResolvedCommand): {
  write: boolean;
  disabledBuiltin: string[];
} {
  const write = resolved.tools.write ?? phaseWritesByDefault(resolved.extends);
  const disabledBuiltin = resolved.tools.builtin?.exclude ?? [];
  return { write, disabledBuiltin };
}

export function formatCommandDisplayLabel(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
