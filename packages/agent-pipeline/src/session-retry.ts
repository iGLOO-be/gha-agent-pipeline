import type { AgentPhase } from "./config.js";

const RETRIABLE_FINISH_REASONS = new Set(["aborted", "error"]);

export function isRetriableSessionFinishReason(finishReason: string): boolean {
  return RETRIABLE_FINISH_REASONS.has(finishReason);
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

  constructor(
    message: string,
    options: { finishReason: string; sessionId?: string; attempt: number },
  ) {
    super(message);
    this.name = "AgentSessionError";
    this.finishReason = options.finishReason;
    this.sessionId = options.sessionId;
    this.attempt = options.attempt;
  }

  get retriable(): boolean {
    return isRetriableSessionFinishReason(this.finishReason);
  }
}
