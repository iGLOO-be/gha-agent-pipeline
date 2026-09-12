const SECRET_ENV_KEYS = ["OPENROUTER_API_KEY", "GITHUB_TOKEN"] as const;

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
