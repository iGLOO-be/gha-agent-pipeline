import fs from "node:fs";
import { globbySync } from "globby";
import { resolveWorkspaceFilePath } from "../cline/resolve-workspace-path.js";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".turbo",
  "coverage",
  "__pycache__",
  ".cache",
];

const MAX_LIMIT = 1000;

type ListFilesInput = {
  path?: string;
  recursive?: boolean;
  limit?: number;
};

export type ListFilesEntry = {
  path: string;
  type: "file" | "directory";
};

export function listFiles(
  workspaceRoot: string,
  input: ListFilesInput,
): ListFilesEntry[] {
  const targetPath = input.path ?? ".";
  const recursive = input.recursive ?? false;
  const limit = Math.max(1, Math.min(input.limit ?? 200, MAX_LIMIT));

  const absoluteDir = resolveWorkspaceFilePath(workspaceRoot, targetPath);
  const stat = fs.statSync(absoluteDir, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${targetPath}`);
  }

  const patterns = recursive ? ["**/*"] : ["*"];
  const matchedPaths = globbySync(patterns, {
    cwd: absoluteDir,
    onlyFiles: false,
    markDirectories: true,
    dot: true,
    gitignore: true,
    ignore: DEFAULT_IGNORES.map((name) => `**/${name}`),
  });

  const sorted = sortBfs(matchedPaths);
  const limited = sorted.slice(0, limit);

  return limited.map((entryPath) => ({
    path: entryPath,
    type: entryPath.endsWith("/") ? "directory" : "file",
  }));
}

function sortBfs(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const aDepth = depthOf(a);
    const bDepth = depthOf(b);
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }

    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }

    return a.localeCompare(b);
  });
}

function depthOf(entryPath: string): number {
  return entryPath.replace(/\/$/, "").split("/").length;
}
