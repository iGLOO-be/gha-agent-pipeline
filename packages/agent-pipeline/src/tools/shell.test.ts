import { describe, expect, it } from "vitest";
import { sanitizeShellEnv } from "./shell.js";

describe("tools/shell", () => {
  describe("sanitizeShellEnv", () => {
    it("drops OPENROUTER_API_KEY and GITHUB_TOKEN from an injected env", () => {
      const env = {
        OPENROUTER_API_KEY: "secret-or-key",
        GITHUB_TOKEN: "ghs_supersecret",
        PATH: "/usr/bin",
        NODE_ENV: "test",
      };
      const sanitized = sanitizeShellEnv(env);
      expect(sanitized).not.toHaveProperty("OPENROUTER_API_KEY");
      expect(sanitized).not.toHaveProperty("GITHUB_TOKEN");
      expect(sanitized.PATH).toBe("/usr/bin");
      expect(sanitized.NODE_ENV).toBe("test");
    });

    it("leaves other keys untouched", () => {
      const env = { FOO: "bar", BAZ: "qux" };
      expect(sanitizeShellEnv(env)).toEqual({ FOO: "bar", BAZ: "qux" });
    });
  });
});
