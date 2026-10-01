import type { AgentConfig, AgentPhase } from "../config.js";

export const JEV_ROUTER_MODEL_ID = "typesafe/jev-router";

const MAX_PATTERN_LIST_SIZE = 1024;

const JEV_ROUTER_PHASES: readonly AgentPhase[] = [
  "plan",
  "implement",
  "yolo",
  "ci-fix",
  "review-fix",
  "ask",
  "code-review",
];

export type JevRouterPool = {
  models: string[];
  excluded_models: string[];
};

export type ServedModelTracker = {
  record: (model: string) => void;
  list: () => string[];
};

export function createServedModelTracker(): ServedModelTracker {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    record(model: string) {
      const trimmed = model.trim();
      if (!trimmed || trimmed === JEV_ROUTER_MODEL_ID || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      order.push(trimmed);
    },
    list() {
      return [...order];
    },
  };
}

export type JevRouterRequestContext = {
  pool: JevRouterPool;
  metadata: boolean;
  servedModels: ServedModelTracker;
};

export type JevRouterPluginPayload = {
  id: "jev-router";
  models?: string[];
  excluded_models?: string[];
};

export type OpenRouterModelResolution = {
  requestModelId: string;
  logLabel: string;
  jevContext?: JevRouterRequestContext;
};

type JevRouterPhaseConfig = {
  enabled?: boolean;
  models?: string[];
  allowed_models?: string[];
  excluded_models?: string[];
};

type JevRouterConfig = NonNullable<AgentConfig["openrouter"]>["jev_router"];

function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return undefined;
}

function parseEnvPatternList(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergePatternLists(...lists: (string[] | undefined)[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  if (merged.length > MAX_PATTERN_LIST_SIZE) {
    throw new Error(
      `jev-router model pattern list exceeds ${MAX_PATTERN_LIST_SIZE} entries`,
    );
  }
  return merged;
}

function getJevRouterConfig(config: AgentConfig): JevRouterConfig | undefined {
  return config.openrouter?.jev_router;
}

function getPhaseJevConfig(
  config: AgentConfig,
  phase: AgentPhase,
): JevRouterPhaseConfig | undefined {
  const phases = getJevRouterConfig(config)?.phases;
  if (!phases) {
    return undefined;
  }
  return phases[phase];
}

export function isJevRouterEnabledForPhase(
  phase: AgentPhase,
  config: AgentConfig,
): boolean {
  if (!JEV_ROUTER_PHASES.includes(phase)) {
    return false;
  }

  const envEnabled = parseEnvBoolean(process.env.OPENROUTER_JEV_ROUTER_ENABLED);
  const phaseConfig = getPhaseJevConfig(config, phase);

  if (phaseConfig?.enabled === false) {
    return false;
  }
  if (phaseConfig?.enabled === true) {
    return true;
  }
  if (envEnabled !== undefined) {
    return envEnabled;
  }
  return getJevRouterConfig(config)?.enabled ?? false;
}

export function getJevRouterPoolForPhase(
  phase: AgentPhase,
  resolvedSlug: string,
  config: AgentConfig,
): JevRouterPool {
  const globalConfig = getJevRouterConfig(config);
  const phaseConfig = getPhaseJevConfig(config, phase);

  const phaseHasIncludeOverride =
    (phaseConfig?.models?.length ?? 0) > 0 ||
    (phaseConfig?.allowed_models?.length ?? 0) > 0;

  let models = phaseHasIncludeOverride
    ? mergePatternLists(phaseConfig?.models, phaseConfig?.allowed_models)
    : mergePatternLists(globalConfig?.models, globalConfig?.allowed_models);

  let excluded_models =
    phaseConfig?.excluded_models !== undefined
      ? mergePatternLists(phaseConfig.excluded_models)
      : mergePatternLists(globalConfig?.excluded_models);

  if (models.length === 0) {
    models = mergePatternLists(
      parseEnvPatternList(process.env.OPENROUTER_JEV_ROUTER_MODELS),
      parseEnvPatternList(process.env.OPENROUTER_JEV_ROUTER_ALLOWED_MODELS),
    );
  }
  if (excluded_models.length === 0) {
    excluded_models = parseEnvPatternList(
      process.env.OPENROUTER_JEV_ROUTER_EXCLUDED_MODELS,
    );
  }
  if (models.length === 0) {
    models = [resolvedSlug];
  }

  return { models, excluded_models };
}

export function shouldEnableJevRouterMetadata(
  config: AgentConfig,
  jevActive: boolean,
): boolean {
  if (!jevActive) {
    return false;
  }
  const metadata = getJevRouterConfig(config)?.metadata;
  return metadata ?? true;
}

export function buildJevRouterPlugin(
  pool: JevRouterPool,
): JevRouterPluginPayload {
  const plugin: JevRouterPluginPayload = { id: "jev-router" };
  if (pool.models.length > 0) {
    plugin.models = pool.models;
  }
  if (pool.excluded_models.length > 0) {
    plugin.excluded_models = pool.excluded_models;
  }
  return plugin;
}

export function formatJevRouterLogLabel(pool: JevRouterPool): string {
  const parts: string[] = [];
  if (pool.models.length > 0) {
    parts.push(`models=${pool.models.join(", ")}`);
  }
  if (pool.excluded_models.length > 0) {
    parts.push(`excluded=${pool.excluded_models.join(", ")}`);
  }
  return `${JEV_ROUTER_MODEL_ID} (${parts.join("; ")})`;
}

export function resolveOpenRouterModelForPhase(
  phase: AgentPhase,
  resolvedSlug: string,
  config: AgentConfig,
): OpenRouterModelResolution {
  if (!isJevRouterEnabledForPhase(phase, config)) {
    return {
      requestModelId: resolvedSlug,
      logLabel: resolvedSlug,
    };
  }

  const pool = getJevRouterPoolForPhase(phase, resolvedSlug, config);
  const metadata = shouldEnableJevRouterMetadata(config, true);

  return {
    requestModelId: JEV_ROUTER_MODEL_ID,
    logLabel: formatJevRouterLogLabel(pool),
    jevContext: { pool, metadata, servedModels: createServedModelTracker() },
  };
}

export function extractServedModelsFromOpenRouterPayload(
  payload: unknown,
): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const models: string[] = [];
  const record = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      models.push(value.trim());
    }
  };

  record((payload as { model?: string }).model);

  const pipeline = (
    payload as {
      openrouter_metadata?: {
        pipeline?: Array<{ name?: string; data?: unknown }>;
      };
    }
  ).openrouter_metadata?.pipeline;
  if (Array.isArray(pipeline)) {
    for (const stage of pipeline) {
      if (
        stage?.name !== "jev-router" ||
        !stage.data ||
        typeof stage.data !== "object"
      ) {
        continue;
      }
      const resolved = (stage.data as { resolved_models?: unknown })
        .resolved_models;
      if (Array.isArray(resolved)) {
        for (const entry of resolved) {
          record(entry);
        }
      }
    }
  }

  return models.filter((model) => model !== JEV_ROUTER_MODEL_ID);
}

export function extractServedModelsFromOpenRouterSse(buffer: string): string[] {
  const models: string[] = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      models.push(
        ...extractServedModelsFromOpenRouterPayload(JSON.parse(data)),
      );
    } catch {
      // ignore partial or non-JSON SSE lines
    }
  }
  return models;
}

async function captureServedModelsFromResponse(
  response: Response,
  servedModels: ServedModelTracker,
): Promise<Response> {
  if (!response.body) {
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isEventStream =
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson");

  if (isEventStream) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          for (const model of extractServedModelsFromOpenRouterSse(sseBuffer)) {
            servedModels.record(model);
          }
          controller.close();
          return;
        }
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          for (const model of extractServedModelsFromOpenRouterSse(
            `${line}\n`,
          )) {
            servedModels.record(model);
          }
        }
        controller.enqueue(value);
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const text = await response.text();
  try {
    const payload = JSON.parse(text) as unknown;
    for (const model of extractServedModelsFromOpenRouterPayload(payload)) {
      servedModels.record(model);
    }
  } catch {
    for (const model of extractServedModelsFromOpenRouterSse(text)) {
      servedModels.record(model);
    }
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isOpenRouterChatCompletionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("openrouter.ai")) {
      return false;
    }
    return (
      parsed.pathname.includes("/chat/completions") ||
      parsed.pathname.includes("/responses") ||
      parsed.pathname.includes("/messages")
    );
  } catch {
    return false;
  }
}

function mergeJevRouterPlugins(
  existing: unknown,
  plugin: JevRouterPluginPayload,
): JevRouterPluginPayload[] {
  const list = Array.isArray(existing) ? existing : [];
  const withoutJev = list.filter(
    (entry) =>
      !(
        entry &&
        typeof entry === "object" &&
        "id" in entry &&
        (entry as { id?: string }).id === "jev-router"
      ),
  );
  return [...withoutJev, plugin];
}

export function createJevRouterFetch(
  plugin: JevRouterPluginPayload,
  servedModels?: ServedModelTracker,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (!isOpenRouterChatCompletionUrl(url)) {
      return baseFetch(input, init);
    }

    let nextInit = init;
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.model === JEV_ROUTER_MODEL_ID) {
          nextInit = {
            ...init,
            body: JSON.stringify({
              ...body,
              plugins: mergeJevRouterPlugins(body.plugins, plugin),
            }),
          };
        }
      } catch {
        // pass through unchanged
      }
    }

    const response = await baseFetch(input, nextInit);
    if (!servedModels) {
      return response;
    }
    try {
      return await captureServedModelsFromResponse(response, servedModels);
    } catch {
      return response;
    }
  };
}
