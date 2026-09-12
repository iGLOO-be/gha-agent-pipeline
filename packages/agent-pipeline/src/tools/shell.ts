import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const SECRET_ENV_KEYS = new Set(["OPENROUTER_API_KEY", "GITHUB_TOKEN"]);

export function sanitizeShellEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_ENV_KEYS) {
    delete clean[key];
  }
  return clean;
}

function ghCliEnv(): NodeJS.ProcessEnv {
  const env = sanitizeShellEnv();
  if (process.env.GITHUB_TOKEN) {
    env.GH_TOKEN = process.env.GITHUB_TOKEN;
  }
  return env;
}

export async function runShell(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd ?? process.cwd(),
      env: sanitizeShellEnv(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 5 * 60 * 1000,
      shell: "/bin/bash",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message ?? String(error),
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}

export async function runGh(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd ?? process.cwd(),
      env: ghCliEnv(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 5 * 60 * 1000,
      shell: "/bin/bash",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? execError.message ?? String(error),
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    };
  }
}
