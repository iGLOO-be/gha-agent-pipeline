import { describe, expect, it } from "vitest";
import { filterAgentTools } from "./tool-set.js";

describe("filterAgentTools", () => {
  const tools = [{ name: "a" }, { name: "b" }, { name: "c" }] as {
    name: string;
  }[];

  it("returns all tools when no filters", () => {
    expect(filterAgentTools(tools, {})).toHaveLength(3);
  });

  it("excludes by name", () => {
    expect(
      filterAgentTools(tools, { exclude: ["b"] }).map((t) => t.name),
    ).toEqual(["a", "c"]);
  });

  it("includes only listed names", () => {
    expect(
      filterAgentTools(tools, { include: ["a", "c"] }).map((t) => t.name),
    ).toEqual(["a", "c"]);
  });
});
