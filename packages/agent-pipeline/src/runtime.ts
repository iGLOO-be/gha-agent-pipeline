import type { AgentTool } from "@cline/sdk";
import { createWorkspaceScopedEditorExecutor } from "./cline/workspace-scoped-editor.js";
import { createWorkspaceScopedFileReadExecutor } from "./cline/workspace-file-read.js";
import { loadClineSdk } from "./cline.js";
import {
  getRunCommandsTimeoutMs,
  buildToolPolicies,
  getAppName,
  loadAgentConfig,
  type AgentConfig,
  type AgentPhase,
} from "./config.js";
import { getActiveCommand } from "./commands/active.js";
import { sanitizeAgentProcessEnv } from "./env.js";
import {
  OPENROUTER_PROVIDER_ID,
  buildOpenRouterHttpHeaders,
  buildOpenRouterProviderConfig,
  getOpenRouterApiKey,
} from "./llm/gateway.js";
import {
  type JevRouterRequestContext,
  isJevRouterFallbackOnExhaustionEnabled,
  resolveDirectOpenRouterModel,
  resolveOpenRouterModelForPhase,
  type OpenRouterModelResolution,
} from "./llm/jev-router.js";
import {
  createSessionLogger,
  formatUsageBlock,
  ghaGroup,
  appendStepSummary,
  isGitHubActions,
} from "./gha-log.js";
import type { SessionAccumulatedUsage } from "./types/usage.js";
import { workspacePathSystemHint } from "./prompts/workspace-paths.js";
import {
  type RunFrictionCollector,
  setActiveRunFrictionCollector,
} from "./run-friction.js";
import {
  AgentSessionError,
  getSessionContinueMaxAttempts,
  getSessionMaxAttempts,
  getSessionRetryBaseDelayMs,
  isNonRetriableProviderError,
  isRetriableSessionFinishReason,
  isSessionTurnFailure,
  type ProviderErrorInfo,
  resolvePhaseModel,
  SESSION_CONTINUE_USER_PROMPT,
  shouldFallbackFromJevRouter,
  sleep,
} from "./session-retry.js";

type SessionTurnResult = {
  finishReason?: string;
  text?: string;
  iterations?: number;
  toolCalls?: unknown[];
};

function sessionMode(phase: AgentPhase): "plan" | "act" {
  return phase === "plan" ? "plan" : "act";
}

function formatSessionFailureMessage(
  finishReason: string,
  session: { result?: { text?: string } | null; text?: string },
  sessionId?: string,
  attempt?: number,
): string {
  const detail = (session.result?.text ?? session.text)?.trim();
  let message = `Agent session failed (${finishReason})`;
  if (detail) {
    message += `: ${detail}`;
  } else if (finishReason === "aborted") {
    message +=
      ": session ended before completion (provider timeout, context limit, or interrupted tool run — inspect the last tool group in the job log)";
  } else if (finishReason === "error") {
    message += ": model returned an error with no message";
  }
  if (attempt !== undefined && attempt > 1) {
    message += ` [attempt=${attempt}]`;
  }
  if (sessionId) {
    message += ` [sessionId=${sessionId}]`;
  }
  return message;
}

function isSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "SessionNotFoundError") {
    return true;
  }
  const code =
    "code" in error && typeof (error as { code?: string }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return (
    code === "session_not_found" || /session not found/i.test(error.message)
  );
}

function formatFailureWithProvider(
  finishReason: string,
  session: { result?: { text?: string } | null; text?: string },
  sessionId?: string,
  attempt?: number,
  providerError?: ProviderErrorInfo,
): string {
  if (providerError && isNonRetriableProviderError(providerError.message)) {
    const codeSuffix = providerError.code ? ` (${providerError.code})` : "";
    let message = `Agent session failed (${finishReason})${codeSuffix}: ${providerError.message}`;
    if (attempt !== undefined && attempt > 1) {
      message += ` [attempt=${attempt}]`;
    }
    if (sessionId) {
      message += ` [sessionId=${sessionId}]`;
    }
    return message;
  }
  return formatSessionFailureMessage(finishReason, session, sessionId, attempt);
}

function throwAgentSessionFailure(
  finishReason: string,
  turnResult: SessionTurnResult | null | undefined,
  attempt: number,
  sessionId?: string,
  providerError?: ProviderErrorInfo,
): never {
  throw new AgentSessionError(
    formatFailureWithProvider(
      finishReason,
      { result: turnResult ?? null },
      sessionId,
      attempt,
      providerError,
    ),
    {
      finishReason,
      sessionId,
      attempt,
      providerError,
    },
  );
}

export type RunSessionInput = {
  phase: AgentPhase;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  sessionMetadata?: Record<string, unknown>;
  /** When set, editor failures are recorded and exposed for end-of-phase summaries. */
  runFriction?: RunFrictionCollector;
  /** Resolved OpenRouter request model (after optional Jev Router). */
  requestModelId?: string;
  /** Display label for logs (may differ from requestModelId when Jev is active). */
  modelLogLabel?: string;
  jevRouterContext?: JevRouterRequestContext;
};

export type AgentSessionResult = {
  sessionId: string;
  outputText: string;
  finishReason: string;
  usage?: SessionAccumulatedUsage;
  modelId: string;
  /** Upstream model slug(s) reported by OpenRouter when Jev Router is active. */
  servedModelIds?: string[];
  /** Sum of OpenRouter `usage.cost` captured on Jev Router HTTP responses. */
  openRouterCostUsd?: number;
  attempts: number;
  /** Number of agent iterations (model → tools → repeat cycles), from session.result */
  iterations?: number;
  /** Total number of tool calls across all iterations, from session.result.toolCalls */
  toolCallsCount?: number;
};

/** ClineCore can leave timers/sockets open after dispose(); GHA steps wait for process exit. */
export function runAgentMain(main: () => Promise<void>): void {
  void main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

async function createClineCore(config: AgentConfig) {
  const { ClineCore } = await loadClineSdk();
  return ClineCore.create({
    clientName: getAppName(config),
    backendMode: "local",
  });
}

type RunSessionAttemptInput = RunSessionInput & {
  modelId: string;
  attempt: number;
  maxAttempts: number;
};

async function runAgentSessionAttempt(
  input: RunSessionAttemptInput,
): Promise<AgentSessionResult> {
  const apiKey = getOpenRouterApiKey();
  const config = loadAgentConfig();
  const restoreEnv = sanitizeAgentProcessEnv();
  const cwd = process.cwd();
  const customToolNames = input.tools.map((tool) => tool.name);
  const active = getActiveCommand();
  const policyOverrides =
    active && active.extends === input.phase
      ? {
          write: active.tools.write,
          disabledBuiltin: active.tools.builtin?.exclude,
        }
      : undefined;
  const toolPolicies = buildToolPolicies(
    input.phase,
    customToolNames,
    policyOverrides,
  );

  const cline = await createClineCore(config);
  let sessionLogger: ReturnType<typeof createSessionLogger> | undefined;
  let sessionId: string | undefined;
  let usage: SessionAccumulatedUsage | undefined;

  const attemptLabel =
    input.maxAttempts > 1
      ? ` attempt ${input.attempt}/${input.maxAttempts}`
      : "";

  try {
    const requestModelId = input.requestModelId ?? input.modelId;
    const modelLogLabel = input.modelLogLabel ?? requestModelId;

    if (isGitHubActions()) {
      ghaGroup(`Agent ${input.phase} (${modelLogLabel})${attemptLabel}`);
    }

    sessionLogger = createSessionLogger(cline, input.phase, requestModelId);

    const readFile = await createWorkspaceScopedFileReadExecutor(cwd);
    const editor = await createWorkspaceScopedEditorExecutor(cwd);
    const { createDefaultShellExecutor } = await loadClineSdk();
    const bash = createDefaultShellExecutor({
      timeoutMs: getRunCommandsTimeoutMs(config),
    });

    const startSessionConfig = {
      config: {
        providerId: OPENROUTER_PROVIDER_ID,
        modelId: requestModelId,
        apiKey,
        headers: buildOpenRouterHttpHeaders(getAppName(config), {
          jevMetadata: input.jevRouterContext?.metadata,
        }),
        providerConfig: buildOpenRouterProviderConfig(input.jevRouterContext),
        systemPrompt: `${input.systemPrompt}\n\n${workspacePathSystemHint(cwd)}`,
        mode: sessionMode(input.phase),
        cwd,
        workspaceRoot: cwd,
        enableTools: true,
        disableMcpSettingsTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        extraTools: input.tools,
      },
      localRuntime: {
        configExtensions: [],
      },
      capabilities: {
        toolExecutors: {
          readFile,
          editor,
          bash,
        },
      },
      sessionMetadata: {
        ...input.sessionMetadata,
        sessionAttempt: input.attempt,
        sessionMaxAttempts: input.maxAttempts,
      },
      toolPolicies,
    };

    const session = await cline.start({
      prompt: input.prompt,
      ...startSessionConfig,
    });

    sessionId = session.sessionId;
    console.log(`\n[session] id=${sessionId}`);
    if (session.manifestPath) {
      console.log(`[session] manifest=${session.manifestPath}`);
    }

    let turnResult: SessionTurnResult | null | undefined = session.result;
    let continueCount = 0;
    const maxContinues = getSessionContinueMaxAttempts();
    const continueBaseDelayMs = getSessionRetryBaseDelayMs();

    while (
      sessionId &&
      isSessionTurnFailure(turnResult) &&
      isRetriableSessionFinishReason(turnResult?.finishReason ?? "unknown") &&
      continueCount < maxContinues
    ) {
      const lastProviderError = sessionLogger.getLastProviderError();
      if (isNonRetriableProviderError(lastProviderError?.message)) {
        console.warn(
          `[session] skipping in-session continue (non-retriable provider error)`,
        );
        break;
      }

      const failedReason = turnResult?.finishReason ?? "unknown";
      continueCount += 1;
      const delayMs = continueBaseDelayMs * 2 ** (continueCount - 1);
      console.warn(
        `[session] continuing same session in ${delayMs}ms (continue ${continueCount}/${maxContinues}, finishReason=${failedReason})`,
      );
      await sleep(delayMs);

      try {
        const continued = await cline.send(sessionId, {
          prompt: SESSION_CONTINUE_USER_PROMPT,
          mode: sessionMode(input.phase),
        });
        turnResult = continued ?? null;
      } catch (sendError) {
        const providerError = sessionLogger.getLastProviderError();
        if (providerError && isSessionNotFoundError(sendError)) {
          throwAgentSessionFailure(
            "error",
            turnResult ?? null,
            input.attempt,
            sessionId,
            providerError,
          );
        }
        throw sendError;
      }
      const continuedReason = turnResult?.finishReason ?? "unknown";
      console.log(`[session] finishReason=${continuedReason}`);
    }

    const finishReason = turnResult?.finishReason ?? "unknown";
    if (continueCount === 0) {
      console.log(`[session] finishReason=${finishReason}`);
    } else if (!isSessionTurnFailure(turnResult)) {
      console.log(
        `[session] succeeded after ${continueCount} in-session continue(s)`,
      );
    }

    if (sessionId) {
      try {
        const usageSummary = await cline.getAccumulatedUsage(sessionId);
        usage = usageSummary?.aggregateUsage || usageSummary?.usage;

        const servedModelIds =
          input.jevRouterContext?.servedModels.list() ?? [];
        if (servedModelIds.length > 0) {
          console.log(`[session] served models: ${servedModelIds.join(", ")}`);
        }

        const openRouterCostUsd =
          input.jevRouterContext?.usageCost.totalUsd() ?? 0;
        if (openRouterCostUsd > 0) {
          console.log(
            `[session] OpenRouter usage cost: $${openRouterCostUsd.toFixed(4)} USD`,
          );
        }

        if (usage) {
          const { stdout, stepSummary } = formatUsageBlock(
            usage,
            sessionId,
            turnResult?.iterations,
            turnResult?.toolCalls?.length,
            {
              modelId: requestModelId,
              servedModelIds,
              openRouterCostUsd:
                openRouterCostUsd > 0 ? openRouterCostUsd : undefined,
            },
          );
          console.log(stdout);
          appendStepSummary(stepSummary);
        }
      } catch (error) {
        console.warn("Failed to get usage information:", error);
      }
    }

    if (isSessionTurnFailure(turnResult)) {
      throwAgentSessionFailure(
        finishReason,
        turnResult ?? null,
        input.attempt,
        sessionId,
        sessionLogger.getLastProviderError(),
      );
    }

    const servedModelIds =
      input.jevRouterContext?.servedModels.list() ?? undefined;
    const openRouterCostUsd =
      input.jevRouterContext?.usageCost.totalUsd() ?? undefined;

    return {
      sessionId: sessionId!,
      outputText: turnResult?.text ?? "",
      finishReason,
      usage,
      modelId: requestModelId,
      servedModelIds:
        servedModelIds && servedModelIds.length > 0
          ? servedModelIds
          : undefined,
      openRouterCostUsd:
        openRouterCostUsd !== undefined && openRouterCostUsd > 0
          ? openRouterCostUsd
          : undefined,
      attempts: input.attempt,
      iterations: turnResult?.iterations,
      toolCallsCount: turnResult?.toolCalls?.length,
    };
  } finally {
    sessionLogger?.closeAllGroups();
    sessionLogger?.unsubscribe();

    if (sessionId) {
      await cline.stop(sessionId).catch(() => undefined);
    }
    await Promise.race([
      cline.dispose(),
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("ClineCore dispose timed out")),
          30_000,
        );
      }),
    ]).catch((error) => {
      console.error(
        error instanceof Error ? error.message : "ClineCore dispose failed",
      );
    });
    restoreEnv();
  }
}

export async function runAgentSession(
  input: RunSessionInput,
): Promise<AgentSessionResult> {
  const resolvedSlug = resolvePhaseModel(input.phase, input.modelId);
  const config = loadAgentConfig();
  let openRouterModel: OpenRouterModelResolution =
    resolveOpenRouterModelForPhase(input.phase, resolvedSlug, config);
  let jevExhaustionFallbackUsed = false;
  const maxAttempts = getSessionMaxAttempts();
  const baseDelayMs = getSessionRetryBaseDelayMs();
  let lastError: AgentSessionError | undefined;

  if (input.runFriction) {
    setActiveRunFrictionCollector(input.runFriction);
  }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delayMs = baseDelayMs * 2 ** (attempt - 2);
        console.warn(
          `[session] starting new session in ${delayMs}ms (attempt ${attempt}/${maxAttempts}, previous finishReason=${lastError?.finishReason})`,
        );
        await sleep(delayMs);
      }

      try {
        const result = await runAgentSessionAttempt({
          ...input,
          modelId: resolvedSlug,
          requestModelId: openRouterModel.requestModelId,
          modelLogLabel: openRouterModel.logLabel,
          jevRouterContext: openRouterModel.jevContext,
          attempt,
          maxAttempts,
        });
        if (attempt > 1) {
          console.log(
            `[session] succeeded on attempt ${attempt}/${maxAttempts}`,
          );
        }
        return result;
      } catch (error) {
        if (!(error instanceof AgentSessionError)) {
          throw error;
        }
        lastError = error;
        console.warn(
          `[session] attempt ${attempt}/${maxAttempts} failed (${error.finishReason}): ${error.message}`,
        );
        if (
          shouldFallbackFromJevRouter({
            providerMessage: error.providerError?.message,
            jevActive: openRouterModel.jevContext !== undefined,
            fallbackUsed: jevExhaustionFallbackUsed,
            fallbackEnabled: isJevRouterFallbackOnExhaustionEnabled(config),
          })
        ) {
          jevExhaustionFallbackUsed = true;
          openRouterModel = resolveDirectOpenRouterModel(resolvedSlug);
          console.warn(
            `[session] jev-router exhausted; falling back to phase model ${resolvedSlug}`,
          );
          attempt -= 1;
          continue;
        }
        if (!error.retriable || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("Agent session failed with no attempt result");
  } finally {
    if (input.runFriction) {
      setActiveRunFrictionCollector(null);
    }
  }
}
