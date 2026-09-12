import type { AgentTool } from "@cline/sdk";
import { createWorkspaceScopedEditorExecutor } from "./cline/workspace-scoped-editor.js";
import { createWorkspaceScopedFileReadExecutor } from "./cline/workspace-file-read.js";
import { loadClineSdk } from "./cline.js";
import {
  buildToolPolicies,
  getAppName,
  loadAgentConfig,
  type AgentConfig,
  type AgentPhase,
} from "./config.js";
import { sanitizeAgentProcessEnv } from "./env.js";
import {
  OPENROUTER_PROVIDER_ID,
  buildOpenRouterHttpHeaders,
  buildOpenRouterProviderConfig,
  getOpenRouterApiKey,
} from "./llm/gateway.js";
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
  getSessionMaxAttempts,
  getSessionRetryBaseDelayMs,
  resolvePhaseModel,
  sleep,
} from "./session-retry.js";

function sessionMode(phase: AgentPhase): "plan" | "act" {
  return phase === "plan" ? "plan" : "act";
}

function formatSessionFailureMessage(
  finishReason: string,
  session: { result?: { text?: string } | null },
  sessionId?: string,
  attempt?: number,
): string {
  const detail = session.result?.text?.trim();
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

export type RunSessionInput = {
  phase: AgentPhase;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  sessionMetadata?: Record<string, unknown>;
  /** When set, editor failures are recorded and exposed for end-of-phase summaries. */
  runFriction?: RunFrictionCollector;
};

export type AgentSessionResult = {
  sessionId: string;
  outputText: string;
  finishReason: string;
  usage?: SessionAccumulatedUsage;
  modelId: string;
  attempts: number;
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
  const toolPolicies = buildToolPolicies(input.phase, customToolNames);

  const cline = await createClineCore(config);
  let sessionLogger: ReturnType<typeof createSessionLogger> | undefined;
  let sessionId: string | undefined;
  let usage: SessionAccumulatedUsage | undefined;

  const attemptLabel =
    input.maxAttempts > 1
      ? ` attempt ${input.attempt}/${input.maxAttempts}`
      : "";

  try {
    if (isGitHubActions()) {
      ghaGroup(`Agent ${input.phase} (${input.modelId})${attemptLabel}`);
    }

    sessionLogger = createSessionLogger(cline, input.phase, input.modelId);

    const readFile = await createWorkspaceScopedFileReadExecutor(cwd);
    const editor = await createWorkspaceScopedEditorExecutor(cwd);

    const session = await cline.start({
      prompt: input.prompt,
      config: {
        providerId: OPENROUTER_PROVIDER_ID,
        modelId: input.modelId,
        apiKey,
        headers: buildOpenRouterHttpHeaders(getAppName(config)),
        providerConfig: buildOpenRouterProviderConfig(),
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
        },
      },
      sessionMetadata: {
        ...input.sessionMetadata,
        sessionAttempt: input.attempt,
        sessionMaxAttempts: input.maxAttempts,
      },
      toolPolicies,
    });

    sessionId = session.sessionId;
    console.log(`\n[session] id=${sessionId}`);
    if (session.manifestPath) {
      console.log(`[session] manifest=${session.manifestPath}`);
    }

    const finishReason = session.result?.finishReason ?? "unknown";
    console.log(`[session] finishReason=${finishReason}`);

    if (sessionId) {
      try {
        const usageSummary = await cline.getAccumulatedUsage(sessionId);
        usage = usageSummary?.aggregateUsage || usageSummary?.usage;

        if (usage) {
          const { stdout, stepSummary } = formatUsageBlock(usage, sessionId);
          console.log(stdout);
          appendStepSummary(stepSummary);
        }
      } catch (error) {
        console.warn("Failed to get usage information:", error);
      }
    }

    if (
      !session.result ||
      session.result.finishReason === "error" ||
      session.result.finishReason === "aborted"
    ) {
      throw new AgentSessionError(
        formatSessionFailureMessage(
          finishReason,
          session,
          sessionId,
          input.attempt,
        ),
        { finishReason, sessionId, attempt: input.attempt },
      );
    }

    return {
      sessionId: sessionId!,
      outputText: session.result.text,
      finishReason,
      usage,
      modelId: input.modelId,
      attempts: input.attempt,
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
  const modelId = resolvePhaseModel(input.phase, input.modelId);
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
          `[session] retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts}, previous finishReason=${lastError?.finishReason})`,
        );
        await sleep(delayMs);
      }

      try {
        const result = await runAgentSessionAttempt({
          ...input,
          modelId,
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
