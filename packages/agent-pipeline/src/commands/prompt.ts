import type { AgentConfig } from "../config.js";
import { getPhasePromptBody } from "../config.js";
import type { ResolvedCommand } from "./types.js";

export function buildCommandSystemPrompt(
  resolved: ResolvedCommand,
  config: AgentConfig,
): string {
  const roleDescription =
    resolved.prompts.role_description ??
    config.prompts[resolved.extends].role_description;

  let body: string;
  if (resolved.prompts.instructions) {
    body = resolved.prompts.instructions;
  } else {
    body = getPhasePromptBody(resolved.extends, config);
    if (resolved.prompts.append_instructions) {
      body += `\n\n${resolved.prompts.append_instructions}`;
    }
  }

  return `${roleDescription}\n\n${body}`;
}
