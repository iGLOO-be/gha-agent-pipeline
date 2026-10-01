import {
  buildJevRouterPlugin,
  createJevRouterFetch,
  type JevRouterRequestContext,
} from "./jev-router.js";

export const OPENROUTER_PROVIDER_ID = "openrouter";

/** Per-request timeout passed to Cline's OpenRouter handler (milliseconds). */
export const OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Metadata";
export const OPENROUTER_METADATA_ENABLED = "enabled";

export function getOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  return apiKey;
}

/** OpenRouter recommends Referer + Title for routing and rate-limit fairness. */
export function buildOpenRouterHttpHeaders(
  appName?: string,
  options?: { jevMetadata?: boolean },
): Record<string, string> {
  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    (process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
      : "");
  const title =
    process.env.OPENROUTER_APP_TITLE?.trim() ||
    appName ||
    (process.env.GITHUB_REPOSITORY
      ? process.env.GITHUB_REPOSITORY.split("/")[1]
      : "") ||
    "gha-agent";
  const headers: Record<string, string> = {
    "HTTP-Referer": referer,
    "X-Title": title,
  };
  if (options?.jevMetadata) {
    headers[OPENROUTER_METADATA_HEADER] = OPENROUTER_METADATA_ENABLED;
  }
  return headers;
}

export function getOpenRouterRequestTimeoutMs(): number {
  const raw = process.env.OPENROUTER_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return parsed;
}

export type OpenRouterProviderConfig = {
  timeout: number;
  fetch?: typeof fetch;
};

export function buildOpenRouterProviderConfig(
  jevContext?: JevRouterRequestContext,
): OpenRouterProviderConfig {
  const config: OpenRouterProviderConfig = {
    timeout: getOpenRouterRequestTimeoutMs(),
  };
  if (jevContext) {
    config.fetch = createJevRouterFetch(buildJevRouterPlugin(jevContext.pool));
  }
  return config;
}
