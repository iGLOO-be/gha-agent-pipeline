import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll } from "./pr.js";
import { PIPELINE_GHA_CHECKOUT_DIR } from "./worktree-excludes.js";

function runGit(cwd: string, command: string): string {
  return execSync(command, { cwd, stdio: "pipe", shell: "/bin/bash" }).toString();
}

describe("commitAll", () => {
  let worktree: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    worktree = mkdtempSync(join(tmpdir(), "agent-pr-commit-"));
    runGit(worktree, "git init -b main");
    runGit(worktree, "git config user.email test@example.com");
    runGit(worktree, "git config user.name test");
    writeFileSync(join(worktree, "app.txt"), "v1\n");
    runGit(worktree, "git add app.txt && git commit -m base");
    process.chdir(worktree);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(worktree, { recursive: true, force: true });
  });

  it("does not stage the GHA pipeline checkout directory", async () => {
    writeFileSync(join(worktree, "app.txt"), "v2\n");
    const pipelineDir = join(worktree, PIPELINE_GHA_CHECKOUT_DIR);
    mkdirSync(pipelineDir, { recursive: true });
    runGit(pipelineDir, "git init -b main");
    runGit(pipelineDir, "git config user.email test@example.com");
    runGit(pipelineDir, "git config user.name test");
    writeFileSync(join(pipelineDir, "package.json"), "{}\n");
    runGit(pipelineDir, "git add package.json && git commit -m init");

    const committed = await commitAll("feat: app only");
    expect(committed).toBe(true);

    const committedFiles = runGit(
      worktree,
      "git show --name-only --pretty=format: HEAD",
    );
    expect(committedFiles.trim()).toBe("app.txt");
    const status = runGit(worktree, "git status --porcelain");
    expect(status).toContain(`?? ${PIPELINE_GHA_CHECKOUT_DIR}/`);
  });
});
