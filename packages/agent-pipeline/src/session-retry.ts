import type { AgentPhase } from "./config.js";

const RETRIABLE_FINISH_REASONS = new Set(["aborted", "error"]);

export type ProviderErrorInfo = {
  code?: string;
  message: string;
};

const JEV_ROUTER_ADMISSION_FAILURE_PATTERNS = [
  /no model left by the jev-router/i,
  /no model admitted/i,
] as const;

const NON_RETRIABLE_PROVIDER_ERROR_PATTERNS = [
  ...JEV_ROUTER_ADMISSION_FAILURE_PATTERNS,
  /no models? (?:are )?available/i,
  /no endpoints? found/i,
  /model not found/i,
  /not a valid model/i,
  /invalid model/i,
] as const;

export type ProviderErrorClass = "non-retriable" | "transient";

export function isJevRouterAdmissionFailure(message?: string | null): boolean {
  if (!message?.trim()) {
    return false;
  }
  return JEV_ROUTER_ADMISSION_FAILURE_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

export function shouldFallbackFromJevRouter(input: {
  providerMessage?: string | null;
  jevActive: boolean;
  fallbackUsed: boolean;
  fallbackEnabled: boolean;
}): boolean {
  if (!input.fallbackEnabled || input.fallbackUsed || !input.jevActive) {
    return false;
  }
  return isJevRouterAdmissionFailure(input.providerMessage);
}

export function isNonRetriableProviderError(message?: string | null): boolean {
  if (!message?.trim()) {
    return false;
  }
  return NON_RETRIABLE_PROVIDER_ERROR_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

export function classifyProviderError(
  message?: string | null,
): ProviderErrorClass {
  return isNonRetriableProviderError(message) ? "non-retriable" : "transient";
}

/** User message sent on `cline.send` after a retriable in-session failure. */
export const SESSION_CONTINUE_USER_PROMPT =
  "The previous model turn failed due to a transient provider error. Continue the assigned task from the current workspace state. Do not repeat work that is already complete unless verification requires it.";

export function isRetriableSessionFinishReason(finishReason: string): boolean {
  return RETRIABLE_FINISH_REASONS.has(finishReason);
}

export function isSessionTurnFailure(
  result: { finishReason?: string } | null | undefined,
): boolean {
  if (!result) {
    return true;
  }
  return result.finishReason === "error" || result.finishReason === "aborted";
}

export function getSessionContinueMaxAttempts(): number {
  const raw = process.env.AGENT_SESSION_CONTINUE_MAX_ATTEMPTS;
  if (!raw) {
    return 2;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
    return 2;
  }
  return parsed;
}

export function getSessionMaxAttempts(): number {
  const raw = process.env.AGENT_SESSION_MAX_ATTEMPTS;
  if (!raw) {
    return 3;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
    return 3;
  }
  return parsed;
}

export function getSessionRetryBaseDelayMs(): number {
  const raw = process.env.AGENT_SESSION_RETRY_BASE_DELAY_MS;
  if (!raw) {
    return 10_000;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 10_000;
  }
  return parsed;
}

export function resolvePhaseModel(
  phase: AgentPhase,
  defaultModel: string,
): string {
  const envKey = `AGENT_MODEL_${phase.replace(/-/g, "_").toUpperCase()}`;
  const override = process.env[envKey]?.trim();
  return override || defaultModel;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AgentSessionError extends Error {
  readonly finishReason: string;
  readonly sessionId?: string;
  readonly attempt: number;
  readonly providerError?: ProviderErrorInfo;

  constructor(
    message: string,
    options: {
      finishReason: string;
      sessionId?: string;
      attempt: number;
      providerError?: ProviderErrorInfo;
    },
  ) {
    super(message);
    this.name = "AgentSessionError";
    this.finishReason = options.finishReason;
    this.sessionId = options.sessionId;
    this.attempt = options.attempt;
    this.providerError = options.providerError;
  }

  get retriable(): boolean {
    if (
      this.providerError &&
      isNonRetriableProviderError(this.providerError.message)
    ) {
      return false;
    }
    return isRetriableSessionFinishReason(this.finishReason);
  }
}
