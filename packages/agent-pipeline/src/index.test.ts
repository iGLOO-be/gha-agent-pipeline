import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@igloo/agent-pipeline scaffold", () => {
  it("exports package name", () => {
    expect(PACKAGE_NAME).toBe("@igloo/agent-pipeline");
  });
});
