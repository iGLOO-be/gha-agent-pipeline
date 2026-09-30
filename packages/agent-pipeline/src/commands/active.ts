import type { AgentConfig, AgentPhase } from "../config.js";
import { PHASE_LABELS } from "../lifecycle.js";
import {
  commandCapabilities,
  formatCommandDisplayLabel,
  resolveCommand,
} from "./resolve.js";
import type { ResolvedCommand } from "./types.js";

let activeCommand: ResolvedCommand | undefined;

export function setActiveCommand(command: ResolvedCommand): void {
  activeCommand = command;
}

export function getActiveCommand(): ResolvedCommand | undefined {
  return activeCommand;
}

export function clearActiveCommand(): void {
  activeCommand = undefined;
}

export type CommandRuntimeContext = {
  resolved: ResolvedCommand;
  runtimePhase: AgentPhase;
  commandId: string;
  modelId: string;
  systemPrompt: string;
  capabilities: ReturnType<typeof commandCapabilities>;
  displayLabel: string;
};

export function activateCommandRuntime(
  expectedExtends: AgentPhase,
  config: AgentConfig,
  buildSystemPrompt: (resolved: ResolvedCommand, config: AgentConfig) => string,
  defaultModel: string,
): CommandRuntimeContext {
  const commandId = process.env.AGENT_COMMAND_ID?.trim() || expectedExtends;
  const resolved = resolveCommand(commandId, config);
  if (!resolved.enabled) {
    throw new Error(`Command "${commandId}" is disabled`);
  }
  if (resolved.extends !== expectedExtends) {
    throw new Error(
      `Command "${commandId}" extends "${resolved.extends}" but this handler is "${expectedExtends}"`,
    );
  }

  setActiveCommand(resolved);

  const modelId = resolved.model ?? defaultModel;
  return {
    resolved,
    runtimePhase: resolved.extends,
    commandId: resolved.id,
    modelId,
    systemPrompt: buildSystemPrompt(resolved, config),
    capabilities: commandCapabilities(resolved),
    displayLabel:
      resolved.id === resolved.extends
        ? (PHASE_LABELS[resolved.extends] ?? resolved.extends)
        : formatCommandDisplayLabel(resolved.id),
  };
}
