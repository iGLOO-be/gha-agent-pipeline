import { appendStepSummary, redactSensitiveStrings } from "./gha-log.js";

export const RUN_FRICTION_CATEGORIES = [
  "tool_limit",
  "tool_error",
  "wrong_tool_choice",
  "missing_context",
  "inefficient_strategy",
  "repo_constraint",
  "other",
] as const;

export type RunFrictionCategory = (typeof RUN_FRICTION_CATEGORIES)[number];
export type RunFrictionSource = "agent" | "runtime";

export type RunFrictionNote = {
  source: RunFrictionSource;
  category: RunFrictionCategory;
  summary: string;
  mitigation?: string;
  context?: string;
};

export type RunFrictionCollectorOptions = {
  maxNotes?: number;
  maxFieldLength?: number;
};

const DEFAULT_MAX_NOTES = 10;
const DEFAULT_MAX_FIELD_LENGTH = 500;

function truncateField(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function normalizeCategory(value: string): RunFrictionCategory {
  if (RUN_FRICTION_CATEGORIES.includes(value as RunFrictionCategory)) {
    return value as RunFrictionCategory;
  }
  return "other";
}

export class RunFrictionCollector {
  private readonly maxNotes: number;
  private readonly maxFieldLength: number;
  private readonly notes: RunFrictionNote[] = [];
  private droppedCount = 0;

  constructor(options: RunFrictionCollectorOptions = {}) {
    this.maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
    this.maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  }

  get noteCount(): number {
    return this.notes.length;
  }

  get droppedNoteCount(): number {
    return this.droppedCount;
  }

  list(): readonly RunFrictionNote[] {
    return this.notes;
  }

  record(note: RunFrictionNote): { accepted: boolean; index?: number } {
    const normalized: RunFrictionNote = {
      source: note.source,
      category: note.category,
      summary: truncateField(
        redactSensitiveStrings(note.summary),
        this.maxFieldLength,
      ),
      mitigation: note.mitigation
        ? truncateField(
            redactSensitiveStrings(note.mitigation),
            this.maxFieldLength,
          )
        : undefined,
      context: note.context
        ? truncateField(
            redactSensitiveStrings(note.context),
            this.maxFieldLength,
          )
        : undefined,
    };

    if (!normalized.summary) {
      return { accepted: false };
    }

    if (this.notes.length >= this.maxNotes) {
      this.droppedCount += 1;
      return { accepted: false };
    }

    this.notes.push(normalized);
    return { accepted: true, index: this.notes.length - 1 };
  }

  recordRuntimeToolError(
    toolName: string,
    errorMessage: string,
    context?: string,
  ): void {
    const category: RunFrictionCategory = errorMessage.includes(
      "Editor input too large",
    )
      ? "tool_limit"
      : "tool_error";
    this.record({
      source: "runtime",
      category,
      summary: `${toolName}: ${errorMessage}`,
      context,
    });
  }
}

let activeCollector: RunFrictionCollector | null = null;

export function setActiveRunFrictionCollector(
  collector: RunFrictionCollector | null,
): void {
  activeCollector = collector;
}

export function getActiveRunFrictionCollector(): RunFrictionCollector | null {
  return activeCollector;
}

export function createRunFrictionCollector(
  options?: RunFrictionCollectorOptions,
): RunFrictionCollector {
  return new RunFrictionCollector(options);
}

export function formatRunFrictionMarkdown(
  collector: RunFrictionCollector,
): string | null {
  if (collector.noteCount === 0) {
    return null;
  }

  const lines = collector.list().map((note) => {
    const parts = [`- **[${note.source}/${note.category}]** ${note.summary}`];
    if (note.context) {
      parts.push(`  - Context: ${note.context}`);
    }
    if (note.mitigation) {
      parts.push(`  - Mitigation: ${note.mitigation}`);
    }
    return parts.join("\n");
  });

  if (collector.droppedNoteCount > 0) {
    lines.push(
      `- _(${collector.droppedNoteCount} additional note(s) omitted — collector limit reached.)_`,
    );
  }

  return [
    "### Run friction",
    "",
    "Suboptimal moments from this run (retries, tool limits, or agent-reported friction). Not necessarily failures.",
    "",
    ...lines,
  ].join("\n");
}

export function appendRunFrictionStepSummary(
  collector: RunFrictionCollector,
  phase: string,
): void {
  const section = formatRunFrictionMarkdown(collector);
  if (!section) {
    return;
  }
  appendStepSummary(
    `\n## Run friction (${phase})\n\n${section.replace(/^### Run friction\n\n/, "")}\n`,
  );
}

export function appendRunFrictionToMarkdown(
  body: string,
  collector: RunFrictionCollector,
): string {
  const section = formatRunFrictionMarkdown(collector);
  if (!section) {
    return body;
  }
  return `${body}\n\n${section}`;
}

export function parseAgentFrictionCategory(value: string): RunFrictionCategory {
  return normalizeCategory(value);
}
