import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runGit(cwd: string, command: string): void {
  execSync(command, { cwd, stdio: "pipe", shell: "/bin/bash" });
}

function setupRepo(): { worktree: string; remote: string } {
  const worktree = mkdtempSync(join(tmpdir(), "agent-sync-work-"));
  const remote = mkdtempSync(join(tmpdir(), "agent-sync-remote-"));

  runGit(worktree, "git init -b main");
  runGit(worktree, "git config user.email test@example.com");
  runGit(worktree, "git config user.name test");
  writeFileSync(join(worktree, "file.txt"), "base\n");
  runGit(worktree, "git add file.txt && git commit -m base");

  runGit(remote, "git init --bare");
  runGit(worktree, `git remote add origin ${remote}`);
  runGit(worktree, "git push -u origin main");

  return { worktree, remote };
}

async function withRepo<T>(fn: (worktree: string) => Promise<T>): Promise<T> {
  const { worktree, remote } = setupRepo();
  const previousCwd = process.cwd();
  process.chdir(worktree);
  try {
    return await fn(worktree);
  } finally {
    process.chdir(previousCwd);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
}

describe("git/sync", () => {
  it("detects no sync needed when up to date with origin/main", async () => {
    await withRepo(async () => {
      const { needsBaseSync } = await import("./sync.js");
      expect(await needsBaseSync("main")).toBe(false);
    });
  });

  it("detects sync needed on a diverged branch", async () => {
    await withRepo(async () => {
      const { needsBaseSync, fetchBase } = await import("./sync.js");

      runGit(process.cwd(), "git checkout -b feature");
      writeFileSync(join(process.cwd(), "file.txt"), "base\nfeature\n");
      runGit(process.cwd(), "git add file.txt && git commit -m feature");

      runGit(process.cwd(), "git checkout main");
      writeFileSync(join(process.cwd(), "file.txt"), "base\nmain\n");
      runGit(process.cwd(), "git add file.txt && git commit -m main");
      runGit(process.cwd(), "git push origin main");

      runGit(process.cwd(), "git checkout feature");
      await fetchBase("main");

      expect(await needsBaseSync("main")).toBe(true);
    });
  });

  it("detects sync needed when feature is behind main", async () => {
    await withRepo(async () => {
      const { needsBaseSync, fetchBase } = await import("./sync.js");

      runGit(process.cwd(), "git checkout -b feature");
      writeFileSync(join(process.cwd(), "feature-only.txt"), "x\n");
      runGit(
        process.cwd(),
        'git add feature-only.txt && git commit -m "feature only"',
      );

      runGit(process.cwd(), "git checkout main");
      writeFileSync(join(process.cwd(), "main-only.txt"), "y\n");
      runGit(
        process.cwd(),
        'git add main-only.txt && git commit -m "main only"',
      );
      runGit(process.cwd(), "git push origin main");

      runGit(process.cwd(), "git checkout feature");
      await fetchBase("main");
      expect(await needsBaseSync("main")).toBe(true);
    });
  });

  it("ignores inline conflict markers in source, but detects real conflict markers", async () => {
    await withRepo(async () => {
      const {
        assertNoConflictMarkersInRepository,
        findPathsWithConflictMarkers,
      } = await import("./sync.js");

      writeFileSync(
        join(process.cwd(), "prompt-doc.ts"),
        'const hint = "Remove markers (<<<<<<<, =======, >>>>>>>)";\n',
      );
      runGit(process.cwd(), "git add prompt-doc.ts && git commit -m doc");
      expect(await findPathsWithConflictMarkers()).toHaveLength(0);
      await assertNoConflictMarkersInRepository();

      writeFileSync(
        join(process.cwd(), "conflicted.txt"),
        "line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
      );
      runGit(process.cwd(), "git add conflicted.txt");
      const paths = await findPathsWithConflictMarkers();
      expect(paths).toContain("conflicted.txt");
    });
  });

  it("syncWithBaseBranch skips tools/agent overlay when harness path is absent", async () => {
    await withRepo(async () => {
      const { syncWithBaseBranch } = await import("./sync.js");

      runGit(process.cwd(), "git checkout -b feature");
      writeFileSync(join(process.cwd(), "feature-only.txt"), "x\n");
      runGit(
        process.cwd(),
        'git add feature-only.txt && git commit -m "feature only"',
      );

      const message = await syncWithBaseBranch("main", "resolve conflicts");
      expect(message).toContain("up to date with main");
    });
  });

  it("prepares a resolved merge for commit", async () => {
    await withRepo(async () => {
      const { prepareResolvedMergeForCommit } = await import("./sync.js");

      runGit(process.cwd(), "git checkout -b feature");
      writeFileSync(join(process.cwd(), "file.txt"), "base\nfeature\n");
      runGit(process.cwd(), "git add file.txt && git commit -m feature");

      runGit(process.cwd(), "git checkout main");
      writeFileSync(join(process.cwd(), "file.txt"), "base\nmain\n");
      runGit(process.cwd(), "git add file.txt && git commit -m main");
      runGit(process.cwd(), "git push origin main");

      runGit(process.cwd(), "git checkout feature");
      try {
        runGit(process.cwd(), "git merge origin/main --no-edit");
      } catch {
        // expected conflict
      }

      writeFileSync(join(process.cwd(), "file.txt"), "base\nfeature\nmain\n");
      await prepareResolvedMergeForCommit();
      runGit(process.cwd(), 'git commit -m "complete merge"');
    });
  });
});
