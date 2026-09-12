import { appendFileSync } from "fs";
import type { SessionAccumulatedUsage } from "./types/usage.js";

/**
 * GitHub Actions observability helpers
 */

const DEFAULT_MAX_TOOL_LENGTH = 2000;
const MIN_SECRET_LENGTH = 8;

export function isGitHubActions(): boolean {
  return (
    process.env.GITHUB_ACTIONS === "true" && process.env.AGENT_LOG_GHA !== "0"
  );
}

export function ghaGroup(title: string): void {
  if (isGitHubActions()) {
    console.log(`::group::${title}`);
  }
}

export function ghaEndGroup(): void {
  if (isGitHubActions()) {
    console.log("::endgroup::");
  }
}

export function ghaNotice(message: string): void {
  if (isGitHubActions()) {
    console.log(`::notice::${message}`);
  }
}

export function appendStepSummary(markdown: string): void {
  if (isGitHubActions() && process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    } catch (error) {
      console.error("Failed to write to GITHUB_STEP_SUMMARY:", error);
    }
  }
}

/**
 * Mask common secrets in log text. Only masks non-empty values with at
 * least {@link MIN_SECRET_LENGTH} characters to avoid false positives.
 */
export function redactSensitiveStrings(text: string): string {
  const secrets = [
    process.env.GITHUB_TOKEN,
    process.env.OPENROUTER_API_KEY,
  ].filter(
    (s): s is string =>
      typeof s === "string" && s.length > 0 && s.length >= MIN_SECRET_LENGTH,
  );

  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

/**
 * Format a tool input/output value for human-readable logs.
 *
 * - Pretty-prints objects and arrays with 2-space JSON indentation.
 * - Truncates to `maxLength` (or `AGENT_LOG_MAX_TOOL_LENGTH`, default 2000).
 * - Applies secret redaction before returning.
 */
export function formatToolValue(
  value: unknown,
  maxLength: number = getDefaultMaxToolLength(),
): string {
  let serialized: string;

  if (value === undefined) {
    serialized = "<undefined>";
  } else {
    try {
      if (typeof value === "string") {
        serialized = value;
      } else if (value === null) {
        serialized = "null";
      } else if (
        typeof value === "object" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        serialized = JSON.stringify(value, null, 2);
      } else {
        serialized = String(value);
      }
    } catch {
      serialized = String(value);
    }
  }

  if (serialized.length > maxLength) {
    serialized = `${serialized.slice(0, maxLength)}…(truncated)`;
  }

  return redactSensitiveStrings(serialized);
}

function getDefaultMaxToolLength(): number {
  const envValue = process.env.AGENT_LOG_MAX_TOOL_LENGTH;
  if (!envValue) {
    return DEFAULT_MAX_TOOL_LENGTH;
  }
  const parsed = Number(envValue);
  if (Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_MAX_TOOL_LENGTH;
  }
  return parsed;
}

function buildUsageRows(
  usage: SessionAccumulatedUsage,
  formatter: (label: string, value: string) => string,
): string[] {
  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;

  return [
    formatter("Input tokens", usage.inputTokens.toLocaleString()),
    formatter("Output tokens", usage.outputTokens.toLocaleString()),
    formatter("Cache read tokens", usage.cacheReadTokens.toLocaleString()),
    formatter("Cache write tokens", usage.cacheWriteTokens.toLocaleString()),
    formatter("**Total tokens**", `**${totalTokens.toLocaleString()}**`),
    formatter("**Estimated cost**", `**$${usage.totalCost.toFixed(4)} USD**`),
  ];
}

export function formatUsageMarkdown(
  usage: SessionAccumulatedUsage,
  opts: {
    heading?: string;
    sessionId?: string;
    modelId?: string;
  } = {},
): string {
  const rows = buildUsageRows(
    usage,
    (label, value) => `| ${label} | ${value} |`,
  );
  const headerRows = ["| Metric | Value |", "| --- | --- |"];

  if (opts.sessionId) {
    headerRows.push(`| Session ID | \`${opts.sessionId}\` |`);
  }

  if (opts.modelId) {
    headerRows.push(`| Model | \`${opts.modelId}\` |`);
  }

  const sections = [
    opts.heading ? `\n${opts.heading}\n` : "\n",
    [...headerRows, ...rows].join("\n"),
    "\n_Estimated cost is a provider-side estimate, not official billing._\n",
  ];

  return sections.join("\n");
}

export function safeFormatUsageMarkdown(
  usage: SessionAccumulatedUsage | undefined,
  opts: {
    heading?: string;
    sessionId?: string;
    modelId?: string;
  } = {},
): string | null {
  if (!usage) {
    return null;
  }

  try {
    return formatUsageMarkdown(usage, opts);
  } catch (error) {
    console.warn("Failed to format usage markdown:", error);
    return null;
  }
}

export function formatUsageBlock(
  usage: SessionAccumulatedUsage,
  sessionId: string,
): {
  stdout: string;
  stepSummary: string;
} {
  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;

  // Format for stdout (simple text block)
  const stdout = [
    `\n[usage] Session ${sessionId}:`,
    `  Input tokens: ${usage.inputTokens.toLocaleString()}`,
    `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
    `  Cache read tokens: ${usage.cacheReadTokens.toLocaleString()}`,
    `  Cache write tokens: ${usage.cacheWriteTokens.toLocaleString()}`,
    `  Total tokens: ${totalTokens.toLocaleString()}`,
    `  Estimated cost: $${usage.totalCost.toFixed(4)} USD`,
  ].join("\n");

  // Format for step summary (Markdown table)
  const stepSummary = [
    `\n## Agent Session Usage\n`,
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Session ID | \`${sessionId}\` |`,
    ...buildUsageRows(usage, (label, value) => `| ${label} | ${value} |`),
    `\n\n`,
  ].join("\n");

  return { stdout, stepSummary };
}

export interface SessionLogger {
  unsubscribe: () => void;
  closeAllGroups: () => void;
}

export function createSessionLogger(
  cline: { subscribe: (listener: (event: any) => void) => () => void },
  phase: string,
  modelId: string,
): SessionLogger {
  let openGroups: string[] = [];
  let assistantGroupOpen = false;
  const loggedToolResults = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  let summaryAppended = false;

  const openGroup = (title: string) => {
    ghaGroup(title);
    openGroups.push(title);
  };

  const closeGroup = () => {
    if (openGroups.length > 0) {
      ghaEndGroup();
      openGroups.pop();
    }
  };

  const closeAllGroups = () => {
    appendToolSummary();
    while (openGroups.length > 0) {
      closeGroup();
    }
  };

  const trackToolCall = (toolName: string) => {
    toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);
  };

  const appendToolSummary = () => {
    if (summaryAppended || toolCallCounts.size === 0 || !isGitHubActions()) {
      return;
    }
    summaryAppended = true;

    const toolsList = Array.from(toolCallCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, count]) =>
          `- **${name}**: ${count} call${count === 1 ? "" : "s"}`,
      )
      .join("\n");

    appendStepSummary(`\n## Tools used (${phase})\n\n${toolsList}\n`);
  };

  const logToolInput = (toolName: string, input: unknown) => {
    console.log(`[tool input] ${toolName}`);
    console.log(formatToolValue(input));
  };

  const logToolResult = (toolName: string, output: unknown, error?: string) => {
    if (error) {
      console.log(`[tool error] ${toolName}: ${redactSensitiveStrings(error)}`);
    } else {
      console.log(`[tool output] ${toolName}`);
      console.log(formatToolValue(output));
    }
  };

  const unsubscribe = cline.subscribe((event) => {
    if (event.type === "chunk" && event.payload.stream === "agent") {
      if (isGitHubActions()) {
        // In GHA mode, group assistant output in a collapsible section
        if (!assistantGroupOpen) {
          openGroup("Assistant output");
          assistantGroupOpen = true;
        }
      }
      process.stdout.write(event.payload.chunk);
    }

    if (event.type === "agent_event") {
      const agentEvent = event.payload.event;

      if (
        agentEvent.type === "content_start" &&
        agentEvent.contentType === "tool" &&
        agentEvent.toolName
      ) {
        trackToolCall(agentEvent.toolName);

        if (isGitHubActions()) {
          // Close assistant group if open when starting a tool
          if (assistantGroupOpen) {
            closeGroup();
            assistantGroupOpen = false;
          }
          openGroup(`Tool: ${agentEvent.toolName}`);
          logToolInput(agentEvent.toolName, agentEvent.input);
        } else {
          console.log(`\n[tool] ${agentEvent.toolName}`);
          logToolInput(agentEvent.toolName, agentEvent.input);
        }
      }

      if (
        agentEvent.type === "content_end" &&
        agentEvent.contentType === "tool" &&
        agentEvent.toolName &&
        agentEvent.toolCallId
      ) {
        loggedToolResults.add(agentEvent.toolCallId);
        logToolResult(agentEvent.toolName, agentEvent.output, agentEvent.error);
      }

      if (agentEvent.type === "error") {
        const code =
          agentEvent.error && typeof agentEvent.error === "object"
            ? String(
                (agentEvent.error as { code?: string }).code ?? "unknown_code",
              )
            : "unknown_code";
        const message = agentEvent.error?.message ?? "unknown error";
        if (isGitHubActions()) {
          ghaNotice(`Agent error (${code}): ${message}`);
        } else {
          console.error(`[agent-error] (${code}) ${message}`);
        }
      }

      if (
        agentEvent.type === "iteration_end" &&
        agentEvent.hadToolCalls === false
      ) {
        console.warn(
          `[session] iteration ${agentEvent.iteration ?? "?"} ended without tool calls`,
        );
      }
    }

    if (event.type === "hook") {
      const hookEvent = event.payload;

      if (hookEvent.hookEventName === "tool_result") {
        const record = hookEvent.tool_result;
        const toolCallId = record?.id;
        const toolName = record?.name ?? "unknown";

        if (toolCallId && !loggedToolResults.has(toolCallId)) {
          loggedToolResults.add(toolCallId);
          trackToolCall(toolName);
          logToolResult(toolName, record.output, record.error);
        }

        if (isGitHubActions()) {
          // Close the current tool group
          closeGroup();
        }
      }

      if (
        hookEvent.hookEventName === "agent_end" ||
        hookEvent.hookEventName === "session_shutdown"
      ) {
        appendToolSummary();
      }
    }
  });

  return {
    unsubscribe,
    closeAllGroups,
  };
}
