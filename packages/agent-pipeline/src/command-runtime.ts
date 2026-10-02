import {
  loadAgentConfig,
  type AgentConfig,
  type AgentPhase,
} from "./config.js";
import { activateCommandRuntime } from "./commands/active.js";
import { buildCommandSystemPrompt } from "./commands/prompt.js";
import { resolvePhaseModel } from "./session-retry.js";
import { applyGithubToolSelection } from "./tools/tool-set.js";
import type { AgentTool } from "@cline/sdk";

export function prepareCommandRuntime(
  expectedExtends: AgentPhase,
  defaultModel: string,
  config?: AgentConfig,
) {
  const cfg = config ?? loadAgentConfig();
  const ctx = activateCommandRuntime(
    expectedExtends,
    cfg,
    buildCommandSystemPrompt,
    defaultModel,
  );
  return {
    ...ctx,
    modelId: resolvePhaseModel(ctx.runtimePhase, ctx.modelId),
  };
}

export function applyCommandGithubTools(
  tools: AgentTool[],
  github: "inherit" | string[],
): AgentTool[] {
  return applyGithubToolSelection(tools, github);
}
