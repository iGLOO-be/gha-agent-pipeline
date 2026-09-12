import { loadClineSdk } from "../cline.js";
import {
  type RunFrictionCollector,
  parseAgentFrictionCategory,
} from "../run-friction.js";

export const REPORT_RUN_FRICTION_TOOL_NAME = "reportRunFriction";

export async function createReportRunFrictionTool(
  collector: RunFrictionCollector,
) {
  const { createTool } = await loadClineSdk();

  return createTool({
    name: REPORT_RUN_FRICTION_TOOL_NAME,
    description:
      "Record friction or suboptimal parts of this run (failed tool strategy, missing context, wasted retries). Call when you hit real inefficiency; skip if the run was smooth. Does not end the session.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "tool_limit",
            "tool_error",
            "wrong_tool_choice",
            "missing_context",
            "inefficient_strategy",
            "repo_constraint",
            "other",
          ],
          description: "Kind of friction encountered",
        },
        summary: {
          type: "string",
          description:
            "One or two factual sentences about what went wrong or was inefficient",
        },
        mitigation: {
          type: "string",
          description:
            "Optional: what would have helped (different tool, doc, prompt, human input)",
        },
        context: {
          type: "string",
          description: "Optional: file path, tool name, or step identifier",
        },
      },
      required: ["category", "summary"],
    },
    async execute(input: {
      category: string;
      summary: string;
      mitigation?: string;
      context?: string;
    }) {
      const result = collector.record({
        source: "agent",
        category: parseAgentFrictionCategory(input.category),
        summary: input.summary,
        mitigation: input.mitigation,
        context: input.context,
      });
      return {
        recorded: result.accepted,
        noteIndex: result.index,
        totalNotes: collector.noteCount,
      };
    },
  });
}

export async function withReportRunFrictionTool<T extends { name: string }>(
  tools: T[],
  collector: RunFrictionCollector,
): Promise<T[]> {
  const frictionTool = await createReportRunFrictionTool(collector);
  return [...tools, frictionTool as T];
}
