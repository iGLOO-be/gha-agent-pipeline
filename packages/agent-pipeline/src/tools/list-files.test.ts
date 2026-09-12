import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFiles } from "./list-files.js";

type FixtureEntry = string | null;

function createFixture(
  root: string,
  entries: Record<string, FixtureEntry>,
): void {
  for (const [rel, content] of Object.entries(entries)) {
    const abs = path.join(root, rel);
    if (content === null) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

describe("listFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-files-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns top-level entries only when recursive is false", () => {
    createFixture(tempDir, {
      "src/app/page.tsx": "export default function Page() {}",
      "README.md": "# readme",
      "node_modules/foo/index.js": "module.exports = {}",
      ".git/config": "",
    });

    const result = listFiles(tempDir, { recursive: false });

    expect(result).toEqual([
      { path: "src/", type: "directory" },
      { path: "README.md", type: "file" },
    ]);
  });

  it("lists directories before files at each level", () => {
    createFixture(tempDir, {
      "z-file.txt": "",
      "a-dir/nested.txt": "",
      "m-file.txt": "",
    });

    const result = listFiles(tempDir, { recursive: false });

    expect(result.map((entry) => entry.path)).toEqual([
      "a-dir/",
      "m-file.txt",
      "z-file.txt",
    ]);
  });

  it("traverses subdirectories recursively in BFS order", () => {
    createFixture(tempDir, {
      "src/app/page.tsx": "",
      "src/app/layout.tsx": "",
      "package.json": "{}",
    });

    const result = listFiles(tempDir, { recursive: true });

    expect(result.map((entry) => entry.path)).toEqual([
      "src/",
      "package.json",
      "src/app/",
      "src/app/layout.tsx",
      "src/app/page.tsx",
    ]);
  });

  it("caps results at the configured limit", () => {
    const entries: Record<string, FixtureEntry> = {};
    for (let i = 1; i <= 5; i++) {
      entries[`file${i}.txt`] = "";
    }
    createFixture(tempDir, entries);

    const result = listFiles(tempDir, { recursive: true, limit: 3 });

    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.path)).toEqual([
      "file1.txt",
      "file2.txt",
      "file3.txt",
    ]);
  });

  it("filters default ignores", () => {
    createFixture(tempDir, {
      "src/index.ts": "",
      ".git/config": "",
      "node_modules/foo/index.js": "",
      ".next/server/app.html": "",
      "dist/bundle.js": "",
      ".turbo/turbo.log": "",
      "coverage/lcov.info": "",
      "__pycache__/module.cpython.pyc": "",
      ".cache/eslint/": null,
      "keep.txt": "",
    });

    const result = listFiles(tempDir, { recursive: true });
    const paths = result.map((entry) => entry.path);

    expect(paths).toContain("src/");
    expect(paths).toContain("keep.txt");
    expect(paths).not.toContain(".git/");
    expect(paths).not.toContain("node_modules/");
    expect(paths).not.toContain(".next/");
    expect(paths).not.toContain("dist/");
    expect(paths).not.toContain(".turbo/");
    expect(paths).not.toContain("coverage/");
    expect(paths).not.toContain("__pycache__/");
    expect(paths).not.toContain(".cache/");
  });

  it("respects .gitignore patterns", () => {
    createFixture(tempDir, {
      ".gitignore": "*.log\ndist/\n**/temp",
      "keep.txt": "",
      "debug.log": "",
      "dist/bundle.js": "",
      "src/temp/cache.json": "",
      "src/main.ts": "",
    });

    const result = listFiles(tempDir, { recursive: true });
    const paths = result.map((entry) => entry.path);

    expect(paths).toContain("keep.txt");
    expect(paths).toContain("src/");
    expect(paths).toContain("src/main.ts");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("dist/");
    expect(paths).not.toContain("src/temp/");
  });

  it("throws a descriptive error for non-existent directories", () => {
    expect(() =>
      listFiles(tempDir, { path: "does-not-exist", recursive: false }),
    ).toThrow("Path does not exist: does-not-exist");
  });

  it("throws when path points to a file", () => {
    createFixture(tempDir, { "file.txt": "" });

    expect(() => listFiles(tempDir, { path: "file.txt" })).toThrow(
      "Path is not a directory: file.txt",
    );
  });

  it("defaults path to the workspace root", () => {
    createFixture(tempDir, { "root.txt": "" });

    const result = listFiles(tempDir, {});

    expect(result).toEqual([{ path: "root.txt", type: "file" }]);
  });
});
