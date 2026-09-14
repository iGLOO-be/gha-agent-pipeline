import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createSessionLogger,
  formatToolValue,
  redactSensitiveStrings,
  formatUsageMarkdown,
  formatUsageBlock,
  safeFormatUsageMarkdown,
} from "./gha-log.js";

const ENV_KEYS = [
  "GITHUB_ACTIONS",
  "AGENT_LOG_GHA",
  "AGENT_LOG_MAX_TOOL_LENGTH",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_TOKEN",
  "OPENROUTER_API_KEY",
] as const;

describe("gha-log", () => {
  let originalValues: Record<string, string | undefined> = {};
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalValues = {};
    for (const key of ENV_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
    consoleSpy.mockRestore();
  });

  describe("redactSensitiveStrings", () => {
    it("masks GITHUB_TOKEN and OPENROUTER_API_KEY when set", () => {
      process.env.GITHUB_TOKEN = "ghs_abc123";
      process.env.OPENROUTER_API_KEY = "sk-or-long-key";

      expect(
        redactSensitiveStrings("token=ghs_abc123 key=sk-or-long-key end"),
      ).toBe("token=*** key=*** end");
    });

    it("leaves values unchanged when secrets are not set", () => {
      expect(redactSensitiveStrings("nothing secret here")).toBe(
        "nothing secret here",
      );
    });

    it("does not mask short secrets to avoid false positives", () => {
      process.env.GITHUB_TOKEN = "short";
      process.env.OPENROUTER_API_KEY = "tiny";

      expect(redactSensitiveStrings("short tiny token")).toBe(
        "short tiny token",
      );
    });
  });

  describe("formatToolValue", () => {
    it("pretty-prints objects with 2-space indentation", () => {
      expect(formatToolValue({ a: 1, b: [2, 3] })).toBe(
        JSON.stringify({ a: 1, b: [2, 3] }, null, 2),
      );
    });

    it("passes short strings through", () => {
      expect(formatToolValue("hello")).toBe("hello");
    });

    it("handles primitives", () => {
      expect(formatToolValue(42)).toBe("42");
      expect(formatToolValue(true)).toBe("true");
    });

    it("handles null and undefined", () => {
      expect(formatToolValue(null)).toBe("null");
      expect(formatToolValue(undefined)).toBe("<undefined>");
    });

    it("truncates long values and appends a suffix", () => {
      const value = "x".repeat(3000);
      const result = formatToolValue(value, 100);
      expect(result).toContain("…(truncated)");
      expect(result.length).toBe(100 + "…(truncated)".length);
    });

    it("uses AGENT_LOG_MAX_TOOL_LENGTH from environment when maxLength is omitted", () => {
      process.env.AGENT_LOG_MAX_TOOL_LENGTH = "50";
      const value = "x".repeat(200);
      const result = formatToolValue(value);
      expect(result).toContain("…(truncated)");
      expect(result.length).toBe(50 + "…(truncated)".length);
    });

    it("falls back to default when AGENT_LOG_MAX_TOOL_LENGTH is invalid", () => {
      process.env.AGENT_LOG_MAX_TOOL_LENGTH = "not-a-number";
      const value = "x".repeat(2500);
      const result = formatToolValue(value);
      expect(result).toContain("…(truncated)");
      expect(result.length).toBe(2000 + "…(truncated)".length);
    });

    it("redacts secrets present in serialized output", () => {
      process.env.GITHUB_TOKEN = "ghs_abc123";
      expect(formatToolValue({ message: "using token ghs_abc123" })).toBe(
        '{\n  "message": "using token ***"\n}',
      );
    });

    it("handles circular references gracefully", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      const result = formatToolValue(obj);
      expect(result).toContain("[object Object]");
    });
  });

  describe("createSessionLogger", () => {
    it("logs tool input and output inside a GHA group", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      expect(listeners).toHaveLength(1);
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-1",
            input: { files: [{ path: "README.md" }] },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-1",
            output: [{ query: "README.md", result: "hello", success: true }],
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-1",
            name: "read_files",
            input: { files: [{ path: "README.md" }] },
            output: [{ query: "README.md", result: "hello", success: true }],
            durationMs: 5,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain("::group::Tool: read_files");
      expect(calls.some((c) => c.includes("[tool input] read_files"))).toBe(
        true,
      );
      expect(calls.some((c) => c.includes("[tool output] read_files"))).toBe(
        true,
      );
      // Non-verbose mode shows semantic summaries, not raw JSON
      expect(calls.some((c) => c.includes("read_files [README.md]"))).toBe(
        true,
      );
      expect(calls.some((c) => c.includes("1 file(s), 5 chars"))).toBe(true);
      expect(calls).toContain("::endgroup::");
    });

    it("does not double-log output when hook.tool_result arrives after content_end", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-2",
            input: { commands: ["echo hi"] },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-2",
            output: [{ query: "echo hi", result: "hi", success: true }],
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-2",
            name: "run_commands",
            input: { commands: ["echo hi"] },
            output: [{ query: "echo hi", result: "hi", success: true }],
            durationMs: 12,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      const outputCalls = consoleSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[tool output]"));
      expect(outputCalls).toHaveLength(1);
    });

    it("falls back to hook.tool_result when content_end is missing", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-3",
            input: { commands: ["echo hi"] },
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-3",
            name: "run_commands",
            input: { commands: ["echo hi"] },
            output: [{ query: "echo hi", result: "hi", success: true }],
            durationMs: 12,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls.some((c) => c.includes("[tool output] run_commands"))).toBe(
        true,
      );
      expect(calls.some((c) => c.includes("exit=0"))).toBe(true);
    });

    it("logs tool errors", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-4",
            input: { commands: ["bad"] },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-4",
            error: "command failed",
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls.some((line) => line.includes("[tool error]"))).toBe(true);
      expect(calls.some((line) => line.includes("command failed"))).toBe(true);
    });

    it("appends a tool summary at session end in GHA mode", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_STEP_SUMMARY = "/tmp/gha-log-summary-test.md";

      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      const logger = createSessionLogger(cline, "implement", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-5",
            input: { path: "src/app/page.tsx" },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-5",
            output: "content",
          },
        },
      });

      expect(() => logger.closeAllGroups()).not.toThrow();
    });

    it("filters NDJSON chunks to only show text type in GHA mode", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      // Simulate a chunk with mixed NDJSON types
      const ndjson =
        [
          JSON.stringify({ type: "reasoning", text: "hidden thinking" }),
          JSON.stringify({ type: "text", text: "Hello agent" }),
          JSON.stringify({ type: "usage", inputTokens: 100 }),
          JSON.stringify({ type: "tool", name: "read_files" }),
          JSON.stringify({ type: "text", text: " more text" }),
        ].join("\n") + "\n";

      const stdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        listener({
          type: "chunk",
          payload: { stream: "agent", chunk: ndjson },
        });

        const output = stdoutWrite.mock.calls
          .map((call) => String(call[0]))
          .join("");
        expect(output).toContain("Hello agent");
        expect(output).toContain(" more text");
        expect(output).not.toContain("hidden thinking");
        expect(output).not.toContain("inputTokens");
        expect(output).not.toContain('"tool"');
      } finally {
        stdoutWrite.mockRestore();
      }
    });

    it("shows reasoning chunks when AGENT_LOG_REASONING=1", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.AGENT_LOG_REASONING = "1";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      const ndjson =
        [
          JSON.stringify({ type: "reasoning", text: "Let me think..." }),
          JSON.stringify({ type: "text", text: "Done" }),
        ].join("\n") + "\n";

      const calls: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        calls.push(String(args[0]));
      });

      try {
        listener({
          type: "chunk",
          payload: { stream: "agent", chunk: ndjson },
        });

        expect(calls.some((c) => c.includes("::group::Reasoning"))).toBe(true);
        expect(calls.some((c) => c.includes("Let me think..."))).toBe(true);
      } finally {
        spy.mockRestore();
        delete process.env.AGENT_LOG_REASONING;
      }
    });

    it("passes through raw chunks in non-GHA mode", () => {
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      const rawChunk = '{"type":"text","text":"Hello"}';
      const stdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      try {
        listener({
          type: "chunk",
          payload: { stream: "agent", chunk: rawChunk },
        });

        expect(
          stdoutWrite.mock.calls.some((call) =>
            String(call[0]).includes(rawChunk),
          ),
        ).toBe(true);
      } finally {
        stdoutWrite.mockRestore();
      }
    });

    it("shows verbose tool JSON when AGENT_LOG_VERBOSE_TOOLS=1", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.AGENT_LOG_VERBOSE_TOOLS = "1";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-v1",
            input: { files: [{ path: "README.md" }] },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-v1",
            output: [{ query: "README.md", result: "hello", success: true }],
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(
        calls.some((c) =>
          c.includes(
            JSON.stringify({ files: [{ path: "README.md" }] }, null, 2),
          ),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.includes(
            JSON.stringify(
              [{ query: "README.md", result: "hello", success: true }],
              null,
              2,
            ),
          ),
        ),
      ).toBe(true);

      delete process.env.AGENT_LOG_VERBOSE_TOOLS;
    });

    it("produces semantic summaries for common tools", () => {
      process.env.GITHUB_ACTIONS = "true";
      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      createSessionLogger(cline, "test", "test-model");
      const listener = listeners[0]!;

      // editor tool
      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "editor",
            toolCallId: "call-ed1",
            input: { path: "src/foo.ts", old_text: "bar" },
          },
        },
      });

      // run_commands tool
      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "run_commands",
            toolCallId: "call-rc1",
            input: { command: "npm test" },
          },
        },
      });

      // list_files tool
      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "list_files",
            toolCallId: "call-lf1",
            input: { path: "src", recursive: true },
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls.some((c) => c.includes("editor edit src/foo.ts"))).toBe(
        true,
      );
      expect(calls.some((c) => c.includes("run_commands: npm test"))).toBe(
        true,
      );
      expect(
        calls.some((c) => c.includes("list_files src (recursive=true)")),
      ).toBe(true);
    });

    it("appends a tools timeline with duration to job summary", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_STEP_SUMMARY = "/tmp/gha-log-timeline-test.md";

      const listeners: Array<(event: any) => void> = [];
      const cline = {
        subscribe: vi.fn((listener) => {
          listeners.push(listener);
          return () => {};
        }),
      };

      const logger = createSessionLogger(cline, "implement", "test-model");
      const listener = listeners[0]!;

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_files",
            toolCallId: "call-tl1",
            input: { files: [{ path: "README.md" }] },
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-tl1",
            name: "read_files",
            input: { files: [{ path: "README.md" }] },
            output: [{ query: "README.md", result: "hello", success: true }],
            durationMs: 42,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "agent_end",
        },
      });

      const fs = require("fs");
      const content = fs.readFileSync("/tmp/gha-log-timeline-test.md", "utf8");
      expect(content).toContain("## Tools timeline");
      expect(content).toContain("read_files");
      expect(content).toContain("42ms");
      expect(content).toContain("read_files [README.md]");

      logger.closeAllGroups();
    });
  });
describe("formatUsageMarkdown and formatUsageBlock", () => {
    const sampleUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      totalCost: 0.0123,
    };

    describe("formatUsageMarkdown", () => {
      it("renders a markdown table with token rows and optional heading", () => {
        const result = formatUsageMarkdown(sampleUsage, {
          heading: "### Usage",
        });

        expect(result).toContain("### Usage");
        expect(result).toContain("| Input tokens | 1,000 |");
        expect(result).toContain("| Output tokens | 500 |");
        expect(result).toContain("| Cache read tokens | 200 |");
        expect(result).toContain("| Cache write tokens | 50 |");
        expect(result).toContain("| **Total tokens** | **1,750** |");
        expect(result).toContain("| **Estimated cost** | **$0.0123 USD** |");
        expect(result).toContain("_Estimated cost is a provider-side estimate");
      });

      it("renders session ID and model when provided", () => {
        const result = formatUsageMarkdown(sampleUsage, {
          sessionId: "abc123",
          modelId: "test-model",
        });

        expect(result).toContain("| Session ID | `abc123` |");
        expect(result).toContain("| Model | `test-model` |");
      });

      it("renders iterations and tool calls when provided", () => {
        const result = formatUsageMarkdown(sampleUsage, {
          iterations: 12,
          toolCallsCount: 34,
        });

        expect(result).toContain("| Iterations | 12 |");
        expect(result).toContain("| Tool calls | 34 |");
      });

      it("omits iterations and tool calls when not provided", () => {
        const result = formatUsageMarkdown(sampleUsage, {});

        expect(result).not.toContain("| Iterations |");
        expect(result).not.toContain("| Tool calls |");
      });

      it("renders only iterations when toolCallsCount is omitted", () => {
        const result = formatUsageMarkdown(sampleUsage, {
          iterations: 5,
        });

        expect(result).toContain("| Iterations | 5 |");
        expect(result).not.toContain("| Tool calls |");
      });

      it("renders only tool calls when iterations is omitted", () => {
        const result = formatUsageMarkdown(sampleUsage, {
          toolCallsCount: 10,
        });

        expect(result).not.toContain("| Iterations |");
        expect(result).toContain("| Tool calls | 10 |");
      });
    });

    describe("safeFormatUsageMarkdown", () => {
      it("returns null when usage is undefined", () => {
        expect(safeFormatUsageMarkdown(undefined)).toBeNull();
      });

      it("returns formatted markdown when usage is valid", () => {
        const result = safeFormatUsageMarkdown(sampleUsage, {
          heading: "### Safe Test",
          iterations: 3,
          toolCallsCount: 7,
        });

        expect(result).not.toBeNull();
        expect(result!).toContain("| Iterations | 3 |");
        expect(result!).toContain("| Tool calls | 7 |");
      });
    });

    describe("formatUsageBlock", () => {
      it("includes iterations and tool calls in stdout when provided", () => {
        const { stdout } = formatUsageBlock(
          sampleUsage,
          "session-1",
          8,
          15,
        );

        expect(stdout).toContain("[usage] Session session-1:");
        expect(stdout).toContain("  Iterations: 8");
        expect(stdout).toContain("  Tool calls: 15");
      });

      it("omits iterations and tool calls from stdout when not provided", () => {
        const { stdout } = formatUsageBlock(sampleUsage, "session-2");

        expect(stdout).not.toContain("Iterations:");
        expect(stdout).not.toContain("Tool calls:");
      });

      it("includes iterations and tool calls in step summary when provided", () => {
        const { stepSummary } = formatUsageBlock(
          sampleUsage,
          "session-3",
          3,
          20,
        );

        expect(stepSummary).toContain("| Iterations | 3 |");
        expect(stepSummary).toContain("| Tool calls | 20 |");
      });

      it("omits iterations and tool calls from step summary when not provided", () => {
        const { stepSummary } = formatUsageBlock(sampleUsage, "session-4");

        expect(stepSummary).not.toContain("| Iterations |");
        expect(stepSummary).not.toContain("| Tool calls |");
      });

      it("includes token metrics in both stdout and step summary", () => {
        const { stdout, stepSummary } = formatUsageBlock(
          sampleUsage,
          "session-5",
          2,
          5,
        );

        expect(stdout).toContain("Input tokens: 1,000");
        expect(stdout).toContain("Total tokens: 1,750");
        expect(stepSummary).toContain("| Input tokens | 1,000 |");
        expect(stepSummary).toContain("| **Estimated cost** | **$0.0123 USD** |");
      });
    });
  });
});
