const SECRET_ENV_KEYS = ["OPENROUTER_API_KEY", "GITHUB_TOKEN"] as const;

/**
 * Read an integer env var, clamped into `[min, max]`. Falls back to `fallback`
 * when the variable is unset, empty, or not a finite number.
 */
export function readClampedEnvInt(
  name: string,
  options: { fallback: number; min: number; max: number },
): number {
  const raw = process.env[name];
  if (!raw) {
    return options.fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return options.fallback;
  }
  return Math.min(options.max, Math.max(options.min, parsed));
}

export function sanitizeAgentProcessEnv(): () => void {
  const saved: Partial<Record<(typeof SECRET_ENV_KEYS)[number], string>> = {};

  for (const key of SECRET_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  return () => {
    for (const key of SECRET_ENV_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      }
    }
  };
}
