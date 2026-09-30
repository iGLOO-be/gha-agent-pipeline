import { describe, expect, it } from "vitest";
import {
  effectivePathFilters,
  partitionChangedFiles,
} from "./review-path-filters.js";

describe("partitionChangedFiles", () => {
  it("excludes paths matching ! patterns", () => {
    const result = partitionChangedFiles(
      ["src/a.ts", "libs/translations/data/fr.po", "src/b.ts"],
      ["!libs/translations/data/**"],
    );
    expect(result.reviewed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.ignored).toEqual([
      {
        path: "libs/translations/data/fr.po",
        reason: "excluded by `!libs/translations/data/**`",
      },
    ]);
  });

  it("restricts to include patterns when present", () => {
    const result = partitionChangedFiles(
      ["src/a.ts", "docs/readme.md"],
      ["src/**"],
    );
    expect(result.reviewed).toEqual(["src/a.ts"]);
    expect(result.ignored[0]?.path).toBe("docs/readme.md");
  });

  it("lets exclusions win over includes", () => {
    const result = partitionChangedFiles(
      ["src/generated/foo.ts"],
      ["src/**", "!src/generated/**"],
    );
    expect(result.reviewed).toEqual([]);
    expect(result.ignored[0]?.reason).toContain("generated");
  });
});

describe("effectivePathFilters", () => {
  it("appends default ignores when enabled", () => {
    const filters = effectivePathFilters(["!custom/**"], true);
    expect(filters).toContain("!custom/**");
    expect(filters).toContain("!**/pnpm-lock.yaml");
  });
});
