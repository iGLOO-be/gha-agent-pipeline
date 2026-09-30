import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import type { AgentConfig } from "./config.js";

export type PathInstruction = {
  path: string;
  instructions: string;
};

export type CodeReviewConfig = {
  path_filters: string[];
  path_instructions: PathInstruction[];
  apply_default_ignores: boolean;
};

const CODERABBIT_CONFIG_PATH = ".coderabbit.yaml";
const MAX_PATH_INSTRUCTIONS_CHARS = 4_000;

type PartialCodeReviewConfig = {
  path_filters?: string[];
  path_instructions?: PathInstruction[];
  apply_default_ignores?: boolean;
};

function parseCoderabbitYaml(repoRoot: string): PartialCodeReviewConfig {
  const configPath = join(repoRoot, CODERABBIT_CONFIG_PATH);
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = parseYaml(readFileSync(configPath, "utf8")) as {
    reviews?: {
      path_filters?: string[];
      path_instructions?: { path?: string; instructions?: string }[];
    };
  };

  const reviews = raw.reviews;
  if (!reviews) {
    return {};
  }

  const path_instructions = (reviews.path_instructions ?? [])
    .filter(
      (entry): entry is PathInstruction =>
        typeof entry.path === "string" &&
        entry.path.length > 0 &&
        typeof entry.instructions === "string" &&
        entry.instructions.length > 0,
    )
    .map((entry) => ({
      path: entry.path,
      instructions: entry.instructions.trim(),
    }));

  return {
    path_filters: reviews.path_filters,
    path_instructions,
  };
}

function fromAgentConfig(config: AgentConfig): PartialCodeReviewConfig {
  const codeReview = config.code_review;
  if (!codeReview) {
    return {};
  }
  return {
    path_filters: codeReview.path_filters,
    path_instructions: codeReview.path_instructions,
    apply_default_ignores: codeReview.apply_default_ignores,
  };
}

export function resolveReviewConfig(
  config: AgentConfig,
  repoRoot = process.cwd(),
): CodeReviewConfig {
  const fromAgent = fromAgentConfig(config);
  const fromCoderabbit = parseCoderabbitYaml(repoRoot);

  return {
    path_filters:
      fromAgent.path_filters !== undefined
        ? fromAgent.path_filters
        : (fromCoderabbit.path_filters ?? []),
    path_instructions:
      fromAgent.path_instructions !== undefined
        ? fromAgent.path_instructions
        : (fromCoderabbit.path_instructions ?? []),
    apply_default_ignores:
      fromAgent.apply_default_ignores ??
      fromCoderabbit.apply_default_ignores ??
      false,
  };
}

export function formatPathInstructionsForPrompt(
  pathInstructions: PathInstruction[],
  reviewedFiles: string[],
): string {
  if (pathInstructions.length === 0 || reviewedFiles.length === 0) {
    return "";
  }

  const matched = pathInstructions.filter((entry) =>
    reviewedFiles.some((file) => minimatchForInstruction(file, entry.path)),
  );

  if (matched.length === 0) {
    return "";
  }

  const lines = matched.map(
    (entry) => `- \`${entry.path}\`:\n\n${entry.instructions}`,
  );
  let body = lines.join("\n\n");
  if (body.length > MAX_PATH_INSTRUCTIONS_CHARS) {
    body = `${body.slice(0, MAX_PATH_INSTRUCTIONS_CHARS)}\n\n…(path instructions truncated)`;
  }

  return `### Path-specific review instructions\n\n${body}`;
}

function minimatchForInstruction(filePath: string, pattern: string): boolean {
  return minimatch(filePath, pattern, { dot: true, matchBase: true });
}
