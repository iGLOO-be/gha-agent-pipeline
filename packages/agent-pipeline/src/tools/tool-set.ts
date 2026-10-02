import type { AgentTool } from "@cline/sdk";

export function filterAgentTools(
  tools: AgentTool[],
  options: {
    include?: string[];
    exclude?: string[];
  },
): AgentTool[] {
  const { include, exclude } = options;
  if (
    (!include || include.length === 0) &&
    (!exclude || exclude.length === 0)
  ) {
    return tools;
  }

  return tools.filter((tool) => {
    if (exclude?.includes(tool.name)) {
      return false;
    }
    if (include && include.length > 0 && !include.includes(tool.name)) {
      return false;
    }
    return true;
  });
}

export function applyGithubToolSelection(
  tools: AgentTool[],
  github: "inherit" | string[],
): AgentTool[] {
  if (github === "inherit") {
    return tools;
  }
  return filterAgentTools(tools, { include: github });
}
