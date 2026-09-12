import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createSessionLogger,
  formatToolValue,
  redactSensitiveStrings,
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
            toolName: "read_file",
            toolCallId: "call-1",
            input: { path: "README.md" },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "call-1",
            output: { content: "hello" },
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
            output: { content: "hello" },
            durationMs: 5,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain("::group::Tool: read_file");
      expect(calls).toContain("[tool input] read_file");
      expect(calls).toContain("[tool output] read_file");
      expect(calls).toContain(JSON.stringify({ path: "README.md" }, null, 2));
      expect(calls).toContain(JSON.stringify({ content: "hello" }, null, 2));
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
            toolName: "run_command",
            toolCallId: "call-2",
            input: { command: "echo hi" },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "run_command",
            toolCallId: "call-2",
            output: "hi",
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-2",
            name: "run_command",
            input: { command: "echo hi" },
            output: "hi",
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
            toolName: "run_command",
            toolCallId: "call-3",
            input: { command: "echo hi" },
          },
        },
      });

      listener({
        type: "hook",
        payload: {
          hookEventName: "tool_result",
          tool_result: {
            id: "call-3",
            name: "run_command",
            input: { command: "echo hi" },
            output: "hi",
            durationMs: 12,
            startedAt: new Date(),
            endedAt: new Date(),
          },
        },
      });

      const calls = consoleSpy.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain("[tool output] run_command");
      expect(calls).toContain("hi");
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
            toolName: "run_command",
            toolCallId: "call-4",
            input: { command: "bad" },
          },
        },
      });

      listener({
        type: "agent_event",
        payload: {
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "run_command",
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
            toolName: "read_file",
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
            toolName: "read_file",
            toolCallId: "call-5",
            output: "content",
          },
        },
      });

      expect(() => logger.closeAllGroups()).not.toThrow();
    });
  });
});
