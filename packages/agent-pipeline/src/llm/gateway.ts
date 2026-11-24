import {
  buildJevRouterPlugin,
  createJevRouterFetch,
  type JevRouterRequestContext,
} from "./jev-router.js";

export const OPENROUTER_PROVIDER_ID = "openrouter";

/**
 * Hard cap for one OpenRouter HTTP stream (milliseconds).
 * Cline stores `timeoutMs` on the provider config but does not abort an
 * OpenRouter body that stays open (SSE keepalives such as
 * `: OPENROUTER PROCESSING` reset the socket idle timer). The fetch wrapper
 * below enforces this deadline for the whole response, including the body.
 */
export const OPENROUTER_DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export class OpenRouterRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OpenRouter request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isOpenRouterRequestTimeoutMessage(
  message?: string | null,
): boolean {
  if (!message?.trim()) {
    return false;
  }
  return /OpenRouter request timed out after \d+ms/i.test(message);
}

export const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Metadata";
export const OPENROUTER_METADATA_ENABLED = "enabled";
export const OPENROUTER_APP_VISIBILITY_HEADER = "X-OpenRouter-App-Visibility";
export const OPENROUTER_APP_VISIBILITY_HIDDEN = "hidden";

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
    [OPENROUTER_APP_VISIBILITY_HEADER]: OPENROUTER_APP_VISIBILITY_HIDDEN,
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

/**
 * Cline merges `providerConfig` into the active provider only when
 * `providerConfig.providerId` matches `config.providerId` (see `mf()` in @cline/core).
 */
export type OpenRouterProviderConfig = {
  providerId: typeof OPENROUTER_PROVIDER_ID;
  timeoutMs: number;
  fetch?: typeof fetch;
};

/**
 * Aborts the OpenRouter request if headers or the response body are still
 * in flight after `timeoutMs`. The timer stays armed until the body is
 * finished or cancelled — `fetch` itself resolves as soon as headers arrive.
 */
export function createRequestTimeoutFetch(
  timeoutMs: number,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const timeoutError = new OpenRouterRequestTimeoutError(timeoutMs);
    const timeoutController = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      timeoutController.abort(timeoutError);
      console.warn(`[openrouter] ${timeoutError.message}; aborting the stream`);
      if (reader) {
        void reader.cancel(timeoutError).catch(() => undefined);
      }
    }, timeoutMs);

    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;

    const onCallerAbort = () => {
      finish();
      if (reader) {
        void reader.cancel(init?.signal?.reason).catch(() => undefined);
      }
    };
    init?.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await baseFetch(input, { ...init, signal });
      if (timeoutController.signal.aborted) {
        finish();
        throw timeoutError;
      }
      if (!response.body) {
        finish();
        return response;
      }

      reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (timeoutController.signal.aborted) {
            finish();
            controller.error(timeoutError);
            return;
          }
          try {
            const { done, value } = await reader!.read();
            if (timeoutController.signal.aborted) {
              finish();
              controller.error(timeoutError);
              return;
            }
            if (done) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            finish();
            controller.error(
              timeoutController.signal.aborted ? timeoutError : error,
            );
          }
        },
        cancel(reason) {
          finish();
          return reader?.cancel(reason);
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      finish();
      if (timeoutController.signal.aborted) {
        throw timeoutError;
      }
      throw error;
    }
  };
}

export function buildOpenRouterProviderConfig(
  jevContext?: JevRouterRequestContext,
): OpenRouterProviderConfig {
  const timeoutMs = getOpenRouterRequestTimeoutMs();
  const innerFetch = jevContext
    ? createJevRouterFetch(buildJevRouterPlugin(jevContext.pool), {
        servedModels: jevContext.servedModels,
        usageCost: jevContext.usageCost,
      })
    : globalThis.fetch;
  return {
    providerId: OPENROUTER_PROVIDER_ID,
    timeoutMs,
    fetch: createRequestTimeoutFetch(timeoutMs, innerFetch),
  };
}
