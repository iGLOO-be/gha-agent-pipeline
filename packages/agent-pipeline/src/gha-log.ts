import { appendFileSync } from "fs";
import type { SessionAccumulatedUsage } from "./types/usage.js";

/**
 * GitHub Actions observability helpers
 */

const DEFAULT_MAX_TOOL_LENGTH = 2000;
const MIN_SECRET_LENGTH = 8;
const DEFAULT_REASONING_TRUNCATE = 2000;

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

function isVerboseTools(): boolean {
  return process.env.AGENT_LOG_VERBOSE_TOOLS === "1";
}

function shouldShowReasoning(): boolean {
  return process.env.AGENT_LOG_REASONING === "1";
}

/**
 * Parse a single NDJSON line from the agent stream.
 * Returns the parsed object or null if the line is not valid JSON.
 */
function parseChunkLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** One-line summary of a tool input for GHA operator readability. */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null) return `${toolName}`;
  const obj = input as Record<string, unknown> | undefined;
  switch (toolName) {
    case "editor": {
      const filePath = obj?.path ?? obj?.filePath ?? "?";
      const op = obj?.old_text
        ? "edit"
        : obj?.insert_line
          ? "insert"
          : (obj?.operation ?? "write");
      return `${toolName} ${op} ${filePath}`;
    }
    case "apply_patch": {
      const filePath = obj?.path ?? obj?.file_path ?? obj?.target_file ?? "?";
      return `${toolName} → ${filePath}`;
    }
    case "run_commands": {
      const cmd = typeof obj?.command === "string" ? obj.command : "?";
      const truncated = cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
      return `${toolName}: ${truncated}`;
    }
    case "read_files": {
      if (obj?.files && Array.isArray(obj.files)) {
        const paths = (obj.files as Array<{ path?: string }>).map(
          (f) => f.path ?? "?",
        );
        return `${toolName} [${paths.join(", ")}]`;
      }
      const path = obj?.path ?? obj?.file ?? "?";
      return `${toolName} ${path}`;
    }
    case "readIssue": {
      return `${toolName}`;
    }
    case "readComments": {
      return `${toolName}`;
    }
    case "list_files": {
      const target = obj?.path ?? obj?.target_directory ?? ".";
      const depth = obj?.depth ?? obj?.recursive ?? "";
      return `${toolName} ${target}${depth ? ` (recursive=${depth})` : ""}`;
    }
    case "readCheckRuns":
    case "readCheckLogs": {
      return `${toolName}`;
    }
    case "search_codebase": {
      const patterns = obj?.queries ?? obj?.pattern ?? "?";
      const patternStr = Array.isArray(patterns)
        ? (patterns as string[]).slice(0, 3).join(", ") +
          (patterns.length > 3 ? ` +${patterns.length - 3} more` : "")
        : String(patterns);
      return `${toolName}: ${patternStr}`;
    }
    default:
      return `${toolName}`;
  }
}

/** One-line summary of a tool output for GHA operator readability. */
function summarizeToolOutput(
  toolName: string,
  output: unknown,
  error?: string,
): string {
  if (error) return `ERROR: ${error}`;
  if (output == null) return "done";
  const obj = output as Record<string, unknown> | undefined;

  switch (toolName) {
    case "run_commands": {
      const exitCode = obj?.exitCode ?? obj?.code ?? "?";
      const stdoutStr =
        typeof obj?.stdout === "string" ? obj.stdout.slice(0, 80) : "";
      return `exit=${exitCode}${stdoutStr ? ` ${stdoutStr}` : ""}`;
    }
    case "read_files": {
      if (obj?.files && Array.isArray(obj.files)) {
        return `${obj.files.length} file(s)`;
      }
      const content = typeof obj?.content === "string" ? obj.content : "";
      return `${content.length} chars`;
    }
    case "readIssue": {
      const number = obj?.number ?? obj?.issue_number ?? "?";
      const title =
        typeof obj?.title === "string" ? obj.title.slice(0, 80) : "";
      return `#${number}${title ? ` ${title}` : ""}`;
    }
    case "readComments": {
      const count = Array.isArray(obj) ? obj.length : (obj?.count ?? "?");
      return `${count} comment(s)`;
    }
    case "list_files": {
      const count = Array.isArray(obj)
        ? obj.length
        : (obj?.entries ?? obj?.count ?? "?");
      return `${count} entries`;
    }
    case "readCheckRuns":
    case "readCheckLogs": {
      const name = obj?.name ?? obj?.check_name ?? "";
      return `${name}`;
    }
    case "editor":
    case "apply_patch": {
      return "done";
    }
    default:
      if (typeof output === "string") {
        const truncated =
          output.length > 120 ? `${output.slice(0, 120)}…` : output;
        return truncated;
      }
      return "done";
  }
}

function formatToolOutputVerbose(
  toolName: string,
  output: unknown,
  error?: string,
): string {
  if (error) {
    return `[tool error] ${toolName}: ${redactSensitiveStrings(error)}`;
  }
  return `[tool output] ${toolName}\n${formatToolValue(output)}`;
}

function formatToolInputVerbose(toolName: string, input: unknown): string {
  return `[tool input] ${toolName}\n${formatToolValue(input)}`;
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
  let reasoningText = "";
  let reasoningGroupOpen = false;
  let chunkBuffer = "";
  interface ToolTimelineEntry {
    toolName: string;
    inputSummary: string;
    outputSummary: string;
    durationMs?: number;
  }
  const toolTimeline: ToolTimelineEntry[] = [];
  const pendingToolCalls = new Map<
    string,
    { toolName: string; inputSummary: string }
  >();

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
    if (summaryAppended || !isGitHubActions()) {
      return;
    }
    summaryAppended = true;

    // Tool counts
    const toolsList = Array.from(toolCallCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, count]) =>
          `- **${name}**: ${count} call${count === 1 ? "" : "s"}`,
      )
      .join("\n");

    appendStepSummary(`\n## Tools used (${phase})\n\n${toolsList}\n`);

    // Tools timeline
    if (toolTimeline.length > 0) {
      const timeline = toolTimeline
        .map(
          (entry, i) =>
            `| ${i + 1} | \`${entry.toolName}\` | ${entry.durationMs != null ? `${entry.durationMs}ms` : "—"} | ${entry.inputSummary} | ${entry.outputSummary} |`,
        )
        .join("\n");

      appendStepSummary(
        `\n## Tools timeline\n\n` +
          `| # | Tool | Duration | Input | Output |\n` +
          `| --- | --- | --- | --- | --- |\n` +
          `${timeline}\n`,
      );
    }
  };

  const flushReasoning = () => {
    if (!reasoningText || !isGitHubActions()) return;
    if (reasoningGroupOpen) {
      // Truncate long reasoning
      let displayed = reasoningText;
      if (displayed.length > DEFAULT_REASONING_TRUNCATE) {
        displayed = `${displayed.slice(0, DEFAULT_REASONING_TRUNCATE)}…(truncated)`;
      }
      console.log(redactSensitiveStrings(displayed));
      closeGroup();
      reasoningGroupOpen = false;
    }
    reasoningText = "";
  };

  const logToolInput = (toolName: string, input: unknown) => {
    const inputSummary = summarizeToolInput(toolName, input);
    if (isVerboseTools()) {
      console.log(formatToolInputVerbose(toolName, input));
    } else {
      console.log(`[tool input] ${toolName}: ${inputSummary}`);
    }
    return inputSummary;
  };

  const logToolResult = (
    toolName: string,
    output: unknown,
    error?: string,
    durationMs?: number,
  ) => {
    const outputSummary = summarizeToolOutput(toolName, output, error);
    if (isVerboseTools()) {
      console.log(formatToolOutputVerbose(toolName, output, error));
    } else if (error) {
      console.log(`[tool error] ${toolName}: ${redactSensitiveStrings(error)}`);
    } else {
      console.log(`[tool output] ${toolName}: ${outputSummary}`);
    }
    return outputSummary;
  };

  const unsubscribe = cline.subscribe((event) => {
    // --- Chunk handler (raw agent stream) ---
    if (event.type === "chunk" && event.payload.stream === "agent") {
      if (isGitHubActions()) {
        // Parse NDJSON lines and only show text (and optionally reasoning)
        chunkBuffer += event.payload.chunk;
        const lines = chunkBuffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        chunkBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const parsed = parseChunkLine(line);
          if (!parsed) continue;

          const chunkType = parsed.type as string | undefined;

          if (chunkType === "text" && typeof parsed.text === "string") {
            flushReasoning();
            // Ensure assistant group is open for text chunks
            if (!assistantGroupOpen) {
              openGroup("Assistant output");
              assistantGroupOpen = true;
            }
            process.stdout.write(parsed.text);
          } else if (
            chunkType === "reasoning" &&
            typeof parsed.text === "string" &&
            shouldShowReasoning()
          ) {
            if (!reasoningGroupOpen) {
              flushReasoning();
              openGroup("Reasoning");
              reasoningGroupOpen = true;
            }
            reasoningText += parsed.text;
          }
          // tool, usage, etc. chunks are handled via agent_event
        }
      } else {
        // Non-GHA mode: pass through raw chunks as before
        process.stdout.write(event.payload.chunk);
      }
    }

    // --- Agent events ---
    if (event.type === "agent_event") {
      const agentEvent = event.payload.event;

      if (
        agentEvent.type === "content_start" &&
        agentEvent.contentType === "tool" &&
        agentEvent.toolName
      ) {
        trackToolCall(agentEvent.toolName);
        const inputSummary = logToolInput(
          agentEvent.toolName,
          agentEvent.input,
        );

        if (isGitHubActions()) {
          // Close assistant group if open when starting a tool
          if (assistantGroupOpen) {
            closeGroup();
            assistantGroupOpen = false;
          }
          // Flush reasoning before tool group
          flushReasoning();
          openGroup(`Tool: ${agentEvent.toolName}`);
        } else {
          console.log(`\n[tool] ${agentEvent.toolName}`);
        }

        // Track pending tool call for timeline
        if (agentEvent.toolCallId) {
          pendingToolCalls.set(agentEvent.toolCallId, {
            toolName: agentEvent.toolName,
            inputSummary,
          });
        }
      }

      // Handle text content_start: flush reasoning and output text
      if (
        agentEvent.type === "content_start" &&
        agentEvent.contentType === "text" &&
        typeof agentEvent.text === "string"
      ) {
        if (isGitHubActions()) {
          flushReasoning();
          if (!assistantGroupOpen) {
            openGroup("Assistant output");
            assistantGroupOpen = true;
          }
          process.stdout.write(agentEvent.text);
        }
      }

      // Handle reasoning content_start via agent_event
      if (
        agentEvent.type === "content_start" &&
        agentEvent.contentType === "reasoning" &&
        typeof agentEvent.reasoning === "string" &&
        shouldShowReasoning()
      ) {
        if (isGitHubActions()) {
          if (!reasoningGroupOpen) {
            flushReasoning();
            openGroup("Reasoning");
            reasoningGroupOpen = true;
          }
          reasoningText += agentEvent.reasoning;
        }
      }

      if (
        agentEvent.type === "content_end" &&
        agentEvent.contentType === "tool" &&
        agentEvent.toolName &&
        agentEvent.toolCallId
      ) {
        if (!loggedToolResults.has(agentEvent.toolCallId)) {
          loggedToolResults.add(agentEvent.toolCallId);

          const outputSummary = logToolResult(
            agentEvent.toolName,
            agentEvent.output,
            agentEvent.error,
          );

          // Resolve pending tool call
          const pending = pendingToolCalls.get(agentEvent.toolCallId);
          if (pending) {
            toolTimeline.push({
              toolName: pending.toolName,
              inputSummary: pending.inputSummary,
              outputSummary,
            });
            pendingToolCalls.delete(agentEvent.toolCallId);
          } else {
            toolTimeline.push({
              toolName: agentEvent.toolName,
              inputSummary: summarizeToolInput(agentEvent.toolName, null),
              outputSummary,
            });
          }
        }
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

    // --- Hook events ---
    if (event.type === "hook") {
      const hookEvent = event.payload;

      if (hookEvent.hookEventName === "tool_result") {
        const record = hookEvent.tool_result;
        const toolCallId = record?.id;
        const toolName = record?.name ?? "unknown";

        if (toolCallId && !loggedToolResults.has(toolCallId)) {
          loggedToolResults.add(toolCallId);
          trackToolCall(toolName);
          const outputSummary = logToolResult(
            toolName,
            record.output,
            record.error,
            record.durationMs,
          );

          // Resolve pending tool call with full data including duration
          const pending = pendingToolCalls.get(toolCallId);
          if (pending) {
            toolTimeline.push({
              toolName: pending.toolName,
              inputSummary: pending.inputSummary,
              outputSummary,
              durationMs: record.durationMs,
            });
            pendingToolCalls.delete(toolCallId);
          } else {
            toolTimeline.push({
              toolName,
              inputSummary: summarizeToolInput(toolName, null),
              outputSummary,
              durationMs: record.durationMs,
            });
          }
        } else if (toolCallId) {
          // Already logged via content_end; update duration if available
          const existing = toolTimeline.find(
            (t) => t.durationMs == null && t.toolName === toolName,
          );
          if (existing && record.durationMs != null) {
            existing.durationMs = record.durationMs;
          }
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
        flushReasoning();
        appendToolSummary();
      }
    }
  });

  return {
    unsubscribe,
    closeAllGroups,
  };
}
