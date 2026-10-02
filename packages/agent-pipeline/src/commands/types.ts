import type { AgentPhase } from "../config.js";

export const BUILTIN_AGENT_PHASES = [
  "plan",
  "implement",
  "yolo",
  "ci-fix",
  "review-fix",
  "ask",
  "code-review",
] as const satisfies readonly AgentPhase[];

export type CommandTarget = "issue" | "pr";

export type CommandOverrideConfig = {
  enabled?: boolean;
  extends?: AgentPhase;
  slash?: string;
  description?: string;
  models?: { model?: string };
  prompts?: {
    role_description?: string;
    instructions?: string;
    append_instructions?: string;
  };
  tools?: {
    write?: boolean;
    github?: "inherit" | string[];
    builtin?: { include?: string[]; exclude?: string[] };
  };
  context?: {
    targets?: CommandTarget[];
    require_plan?: boolean;
  };
  access?: {
    author_associations?: string[];
  };
  output?: {
    marker?: string;
  };
  git?: {
    commit_subject?: string;
    skip_pr?: boolean;
  };
};

export type ResolvedCommand = {
  id: string;
  extends: AgentPhase;
  slash: string;
  enabled: boolean;
  description?: string;
  model?: string;
  prompts: {
    role_description?: string;
    instructions?: string;
    append_instructions?: string;
  };
  tools: {
    write?: boolean;
    github: "inherit" | string[];
    builtin?: { include?: string[]; exclude?: string[] };
  };
  context: {
    targets: CommandTarget[];
    require_plan?: boolean;
  };
  access?: {
    author_associations?: string[];
  };
  output?: {
    marker?: string;
  };
  git?: {
    commit_subject?: string;
    skip_pr?: boolean;
  };
};

export type ListCommandsEntry = {
  id: string;
  slash: string;
  extends: AgentPhase;
  enabled: boolean;
  description?: string;
  targets: CommandTarget[];
  access?: string[];
};
