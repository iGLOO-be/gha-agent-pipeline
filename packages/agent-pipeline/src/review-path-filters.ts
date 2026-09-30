import { minimatch } from "minimatch";

export const DEFAULT_REVIEW_PATH_IGNORES = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/package-lock.json",
  "!**/pnpm-lock.yaml",
  "!**/yarn.lock",
] as const;

export type IgnoredFile = {
  path: string;
  reason: string;
};

export type PartitionChangedFilesResult = {
  reviewed: string[];
  ignored: IgnoredFile[];
};

function splitPathFilters(pathFilters: string[]): {
  includes: string[];
  excludes: string[];
} {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const pattern of pathFilters) {
    if (pattern.startsWith("!")) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }
  return { includes, excludes };
}

function matchesPattern(filePath: string, pattern: string): boolean {
  return minimatch(filePath, pattern, {
    dot: true,
    matchBase: true,
  });
}

function firstMatchingExclude(
  filePath: string,
  excludes: string[],
): string | undefined {
  for (const pattern of excludes) {
    if (matchesPattern(filePath, pattern)) {
      return pattern;
    }
  }
  return undefined;
}

export function partitionChangedFiles(
  files: string[],
  pathFilters: string[],
): PartitionChangedFilesResult {
  const { includes, excludes } = splitPathFilters(pathFilters);
  const reviewed: string[] = [];
  const ignored: IgnoredFile[] = [];

  for (const filePath of files) {
    const excludePattern = firstMatchingExclude(filePath, excludes);
    if (excludePattern) {
      ignored.push({
        path: filePath,
        reason: `excluded by \`!${excludePattern}\``,
      });
      continue;
    }

    if (
      includes.length > 0 &&
      !includes.some((pattern) => matchesPattern(filePath, pattern))
    ) {
      ignored.push({
        path: filePath,
        reason: "outside path filter include scope",
      });
      continue;
    }

    reviewed.push(filePath);
  }

  return { reviewed, ignored };
}

export function effectivePathFilters(
  pathFilters: string[],
  applyDefaultIgnores: boolean,
): string[] {
  if (!applyDefaultIgnores) {
    return [...pathFilters];
  }
  return [...pathFilters, ...DEFAULT_REVIEW_PATH_IGNORES];
}
