import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { AGENT_STATE_DIR } from "../state/cache.js";
import { PIPELINE_GHA_CHECKOUT_DIR } from "./worktree-excludes.js";

const { mockSleep } = vi.hoisted(() => ({
  mockSleep: vi.fn(() => Promise.resolve()),
}));
vi.mock("../session-retry.js", () => ({
  sleep: mockSleep,
}));

import {
  commitAll,
  commitAndPushBranch,
  findOpenPullRequestForBranch,
  getPushMaxAttempts,
  getPushRetryBaseDelayMs,
  pushBranch,
} from "./pr.js";
import * as shell from "../tools/shell.js";

function runGit(cwd: string, command: string): string {
  return execSync(command, {
    cwd,
    stdio: "pipe",
    shell: "/bin/bash",
  }).toString();
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

  it("does not stage the agent local state directory", async () => {
    writeFileSync(join(worktree, "app.txt"), "v2\n");
    mkdirSync(join(worktree, AGENT_STATE_DIR), { recursive: true });
    writeFileSync(join(worktree, AGENT_STATE_DIR, "ci-round"), "1\n");

    const committed = await commitAll("feat: app only");
    expect(committed).toBe(true);

    const committedFiles = runGit(
      worktree,
      "git show --name-only --pretty=format: HEAD",
    );
    expect(committedFiles.trim()).toBe("app.txt");
    expect(committedFiles).not.toContain(AGENT_STATE_DIR);
  });

  it("creates a merge commit when MERGE_HEAD is set and the index matches HEAD", async () => {
    runGit(worktree, "git checkout -b feature");
    writeFileSync(join(worktree, "pin.txt"), "v0.3.3\n");
    runGit(worktree, 'git add pin.txt && git commit -m "feature pin"');

    runGit(worktree, "git checkout main");
    writeFileSync(join(worktree, "pin.txt"), "v0.3.2\n");
    runGit(worktree, 'git add pin.txt && git commit -m "main pin"');

    runGit(worktree, "git checkout feature");
    try {
      runGit(worktree, "git merge main --no-edit");
    } catch {
      // expected conflict
    }

    writeFileSync(join(worktree, "pin.txt"), "v0.3.3\n");
    runGit(worktree, "git add pin.txt");

    const committed = await commitAll("fix: merge main into feature");
    expect(committed).toBe(true);

    const parents = runGit(worktree, "git rev-list --parents -n 1 HEAD").trim();
    expect(parents.split(" ").length).toBe(3);
    expect(runGit(worktree, "git show -s --pretty=%s HEAD").trim()).toBe(
      "fix: merge main into feature",
    );
  });
});

describe("commitAndPushBranch", () => {
  let parentDir: string;
  let worktree: string;
  let bareRemote: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    parentDir = mkdtempSync(join(tmpdir(), "agent-commit-push-"));
    bareRemote = join(parentDir, "origin.git");
    runGit(parentDir, `git init --bare -b main ${bareRemote}`);
    worktree = join(parentDir, "repo");
    runGit(parentDir, `git clone ${bareRemote} repo`);
    process.chdir(worktree);
    runGit(worktree, "git config user.email test@example.com");
    runGit(worktree, "git config user.name test");
    writeFileSync(join(worktree, "base.txt"), "base\n");
    runGit(worktree, "git add base.txt && git commit -m base");
    runGit(worktree, "git push -u origin main");
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(parentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("pushes when the feature branch is ahead of base but not on origin yet", async () => {
    runGit(worktree, "git checkout -b agent/issue-1");
    writeFileSync(join(worktree, "feature.txt"), "work\n");
    runGit(worktree, 'git add feature.txt && git commit -m "agent pre-commit"');

    const result = await commitAndPushBranch(
      "agent/issue-1",
      "feat: runner commit",
      { baseBranch: "main" },
    );

    expect(result).toEqual({ status: "pushed", commitsAhead: 1 });
    runGit(worktree, "git rev-parse --verify origin/agent/issue-1");
  });

  it("returns noChanges when origin branch exists and HEAD matches", async () => {
    runGit(worktree, "git checkout -b synced");
    writeFileSync(join(worktree, "synced.txt"), "x\n");
    runGit(worktree, "git add synced.txt && git commit -m synced");
    runGit(worktree, "git push -u origin synced");
    runGit(worktree, "git checkout synced");

    const result = await commitAndPushBranch("synced", "feat: noop", {
      baseBranch: "main",
    });
    expect(result).toEqual({ status: "noChanges" });
  });

  it("throws instead of noChanges when rev-list fails and a commit was created", async () => {
    runGit(worktree, "git checkout -b dirty-branch");
    writeFileSync(join(worktree, "dirty.txt"), "uncommitted\n");

    const { runShell: originalRunShell } =
      await vi.importActual<typeof import("../tools/shell.js")>(
        "../tools/shell.js",
      );
    vi.spyOn(shell, "runShell").mockImplementation(async (command: string) => {
      if (command.startsWith("git rev-list --count")) {
        return makeShellResult({
          exitCode: 128,
          stderr: "fatal: ambiguous argument",
        });
      }
      return originalRunShell(command);
    });

    await expect(
      commitAndPushBranch("dirty-branch", "feat: should fail", {
        baseBranch: "missing-on-origin",
      }),
    ).rejects.toThrow(/git rev-list --count failed.*committed=true/);
  });

  it("ignores untracked excluded artifacts (nothing to commit) and surfaces the rev-list failure", async () => {
    runGit(worktree, "git checkout -b excluded-only");
    mkdirSync(join(worktree, PIPELINE_GHA_CHECKOUT_DIR), { recursive: true });
    writeFileSync(join(worktree, PIPELINE_GHA_CHECKOUT_DIR, "junk.txt"), "x\n");
    mkdirSync(join(worktree, AGENT_STATE_DIR), { recursive: true });
    writeFileSync(join(worktree, AGENT_STATE_DIR, "ci-round"), "1\n");

    const { runShell: originalRunShell } =
      await vi.importActual<typeof import("../tools/shell.js")>(
        "../tools/shell.js",
      );
    vi.spyOn(shell, "runShell").mockImplementation(async (command: string) => {
      if (command.startsWith("git rev-list --count")) {
        return makeShellResult({
          exitCode: 128,
          stderr: "fatal: ambiguous argument",
        });
      }
      return originalRunShell(command);
    });

    await expect(
      commitAndPushBranch("excluded-only", "feat: should fail", {
        baseBranch: "missing-on-origin",
      }),
    ).rejects.toThrow(/git rev-list --count failed.*committed=false/);
  });
});

// --- pushBranch retry tests -------------------------------------------------

function makeShellResult(
  overrides: Partial<{ stdout: string; stderr: string; exitCode: number }> = {},
): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

describe("pushBranch", () => {
  let runShellSpy: MockInstance;

  beforeEach(() => {
    runShellSpy = vi.spyOn(shell, "runShell");
    mockSleep.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("configuration", () => {
    const MAX_ATTEMPTS_KEY = "AGENT_PUSH_MAX_ATTEMPTS";
    const RETRY_BASE_DELAY_KEY = "AGENT_PUSH_RETRY_BASE_DELAY_MS";

    afterEach(() => {
      delete process.env[MAX_ATTEMPTS_KEY];
      delete process.env[RETRY_BASE_DELAY_KEY];
    });

    it("returns sensible defaults when no env is set", () => {
      expect(getPushMaxAttempts()).toBe(3);
      expect(getPushRetryBaseDelayMs()).toBe(10_000);
    });

    it("parses valid env overrides", () => {
      process.env[MAX_ATTEMPTS_KEY] = "5";
      process.env[RETRY_BASE_DELAY_KEY] = "5000";
      expect(getPushMaxAttempts()).toBe(5);
      expect(getPushRetryBaseDelayMs()).toBe(5000);
    });

    it("clamps invalid values to defaults", () => {
      process.env[MAX_ATTEMPTS_KEY] = "-1";
      process.env[RETRY_BASE_DELAY_KEY] = "nope";
      expect(getPushMaxAttempts()).toBe(3);
      expect(getPushRetryBaseDelayMs()).toBe(10_000);

      process.env[MAX_ATTEMPTS_KEY] = "999";
      expect(getPushMaxAttempts()).toBe(3);
    });
  });

  describe("push with retry", () => {
    beforeEach(() => {
      // Default config: 3 attempts, 10s delay.
      delete process.env.AGENT_PUSH_MAX_ATTEMPTS;
      delete process.env.AGENT_PUSH_RETRY_BASE_DELAY_MS;
    });

    it("succeeds on the first attempt", async () => {
      runShellSpy.mockResolvedValueOnce(makeShellResult({ exitCode: 0 }));

      await pushBranch("feature/x");

      expect(runShellSpy).toHaveBeenCalledTimes(1);
      expect(runShellSpy).toHaveBeenCalledWith("git push -u origin feature/x");
    });

    it("retries on transient network errors then succeeds", async () => {
      runShellSpy
        .mockResolvedValueOnce(
          makeShellResult({
            exitCode: 128,
            stderr:
              "fatal: unable to access 'https://github.com/...': Failed to connect to github.com port 443",
          }),
        )
        .mockResolvedValueOnce(
          makeShellResult({
            exitCode: 128,
            stderr:
              "fatal: unable to access 'https://github.com/...': Couldn't connect to server",
          }),
        )
        .mockResolvedValueOnce(makeShellResult({ exitCode: 0 }));

      await pushBranch("feature/x");

      expect(runShellSpy).toHaveBeenCalledTimes(3);
      expect(mockSleep).toHaveBeenCalledTimes(2);
      // backoff: 10_000 * 2^0 = 10000, then 10_000 * 2^1 = 20000
      expect(mockSleep).toHaveBeenNthCalledWith(1, 10_000);
      expect(mockSleep).toHaveBeenNthCalledWith(2, 20_000);
    });

    it("exhausts retries and rejects with the last error", async () => {
      const stderr =
        "fatal: unable to access 'https://github.com/...': Couldn't connect to server";
      runShellSpy.mockResolvedValue(makeShellResult({ exitCode: 128, stderr }));

      await expect(pushBranch("feature/x")).rejects.toThrow(
        `git push failed after 3 attempts: ${stderr}`,
      );
      expect(runShellSpy).toHaveBeenCalledTimes(3);
    });

    it("handles non-fast-forward in a single attempt (force-with-lease)", async () => {
      runShellSpy
        .mockResolvedValueOnce(
          makeShellResult({
            exitCode: 1,
            stderr:
              "! [rejected]        feature/x -> feature/x (non-fast-forward)",
          }),
        )
        .mockResolvedValueOnce(makeShellResult({ exitCode: 0 }));

      await pushBranch("feature/x");

      expect(runShellSpy).toHaveBeenCalledTimes(2);
      expect(runShellSpy).toHaveBeenNthCalledWith(
        1,
        "git push -u origin feature/x",
      );
      expect(runShellSpy).toHaveBeenNthCalledWith(
        2,
        "git push -u origin feature/x --force-with-lease",
      );
      // no retry sleep for non-fast-forward
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it("throws immediately for non-retriable errors (non-network)", async () => {
      const stderr = "fatal: Authentication failed";
      runShellSpy.mockResolvedValue(makeShellResult({ exitCode: 128, stderr }));

      await expect(pushBranch("feature/x")).rejects.toThrow(
        `git push failed after 1 attempt: ${stderr}`,
      );
      expect(runShellSpy).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it("respects AGENT_PUSH_MAX_ATTEMPTS=1 (no retry)", async () => {
      process.env.AGENT_PUSH_MAX_ATTEMPTS = "1";
      const stderr = "fatal: unable to access ...";
      runShellSpy.mockResolvedValue(makeShellResult({ exitCode: 128, stderr }));

      await expect(pushBranch("feature/x")).rejects.toThrow(
        `git push failed after 1 attempt: ${stderr}`,
      );
      expect(runShellSpy).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });
  });

  describe("findOpenPullRequestForBranch", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns null when no open PR is found", async () => {
      vi.spyOn(shell, "runGh").mockResolvedValue(
        makeShellResult({ exitCode: 0, stdout: "[]" }),
      );

      const result = await findOpenPullRequestForBranch("feat/nonexistent");
      expect(result).toBeNull();
    });

    it("returns PR info when an open PR exists", async () => {
      vi.spyOn(shell, "runGh").mockResolvedValue(
        makeShellResult({
          exitCode: 0,
          stdout: JSON.stringify([
            { number: 42, url: "https://github.com/org/repo/pull/42" },
          ]),
        }),
      );

      const result = await findOpenPullRequestForBranch("feat/existing");
      expect(result).toEqual({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
      });
    });

    it("throws when gh pr list fails", async () => {
      vi.spyOn(shell, "runGh").mockResolvedValue(
        makeShellResult({
          exitCode: 1,
          stderr: "network error: could not connect to GitHub",
        }),
      );

      await expect(findOpenPullRequestForBranch("feat/error")).rejects.toThrow(
        /findOpenPullRequestForBranch: gh pr list failed \(exit 1\)/,
      );
    });
  });
});
