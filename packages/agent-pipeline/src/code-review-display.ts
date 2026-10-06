const OPTIONAL_EMOJI_PREFIX = "(?:\\S+\\s+)?";

/** First line: optional emoji + _Category_ | _Severity_ | _Effort_ */
export const INLINE_REVIEW_TAG_LINE = new RegExp(
  `^${OPTIONAL_EMOJI_PREFIX}_([^|\\n]+)_\\s*\\|\\s*${OPTIONAL_EMOJI_PREFIX}_([^|\\n]+)_\\s*\\|\\s*${OPTIONAL_EMOJI_PREFIX}_([^|\\n]+)_`,
  "m",
);

const CATEGORY_EMOJI: Record<string, string> = {
  "functional correctness": "🐛",
  "security & privacy": "🔒",
  performance: "⚡",
  maintainability: "🧹",
  docs: "📚",
};

const SEVERITY_EMOJI: Record<string, string> = {
  minor: "💡",
  major: "🟠",
  critical: "🔴",
};

const EFFORT_EMOJI: Record<string, string> = {
  "quick win": "✅",
  "needs discussion": "💬",
};

export const MERGE_RISK_LEVEL_EMOJI: Record<
  "minimal" | "moderate" | "high",
  string
> = {
  minimal: "🟢",
  moderate: "🟡",
  high: "🔴",
};

const MERGE_RISK_LEVEL_WORDS: {
  word: "minimal" | "moderate" | "high";
  pattern: RegExp;
}[] = [
  { word: "minimal", pattern: /^(?:level|risk)?[:\s-]*minimal\b/i },
  { word: "moderate", pattern: /^(?:level|risk)?[:\s-]*moderate\b/i },
  { word: "high", pattern: /^(?:level|risk)?[:\s-]*high\b/i },
];

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function emojiForCategory(label: string): string | null {
  return CATEGORY_EMOJI[normalizeKey(label)] ?? null;
}

function emojiForSeverity(label: string): string | null {
  return SEVERITY_EMOJI[normalizeKey(label)] ?? null;
}

function emojiForEffort(label: string): string | null {
  return EFFORT_EMOJI[normalizeKey(label)] ?? null;
}

function formatTagSegment(emoji: string | null, label: string): string {
  const inner = label.trim();
  if (!emoji) {
    return `_${inner}_`;
  }
  return `${emoji} _${inner}_`;
}

function segmentAlreadyHasEmoji(segment: string, emoji: string): boolean {
  return segment.trimStart().startsWith(emoji);
}

/** Adds display emojis to the agent inline review tag line when recognized. */
export function decorateInlineReviewTagLine(line: string): string {
  const match = line.match(INLINE_REVIEW_TAG_LINE);
  if (!match || match.index !== 0) {
    return line;
  }
  const [, category, severity, effort] = match;
  const segments = line.split("|").map((part) => part.trim());

  const catEmoji = emojiForCategory(category);
  const sevEmoji = emojiForSeverity(severity);
  const effEmoji = emojiForEffort(effort);

  const cat =
    catEmoji && segmentAlreadyHasEmoji(segments[0] ?? "", catEmoji)
      ? segments[0]!.trim()
      : formatTagSegment(catEmoji, category);
  const sev =
    sevEmoji && segmentAlreadyHasEmoji(segments[1] ?? "", sevEmoji)
      ? segments[1]!.trim()
      : formatTagSegment(sevEmoji, severity);
  const eff =
    effEmoji && segmentAlreadyHasEmoji(segments[2] ?? "", effEmoji)
      ? segments[2]!.trim()
      : formatTagSegment(effEmoji, effort);

  return `${cat} | ${sev} | ${eff}`;
}

function decorateDetailsSummaries(body: string): string {
  return body
    .replace(/<summary>\s*Suggested fix\s*<\/summary>/gi, (match) =>
      match.includes("🔧")
        ? match
        : match.replace(
            /(<summary>\s*)(Suggested fix)(\s*<\/summary>)/i,
            "$1🔧 $2$3",
          ),
    )
    .replace(/<summary>\s*Evidence\s*<\/summary>/gi, (match) =>
      match.includes("🔍")
        ? match
        : match.replace(
            /(<summary>\s*)(Evidence)(\s*<\/summary>)/i,
            "$1🔍 $2$3",
          ),
    );
}

/** Runner decoration for inline review comment bodies posted to GitHub. */
export function decorateInlineReviewCommentBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return body;
  }
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = trimmed.split(/\r?\n/);
  const [first, ...rest] = lines;
  const decoratedFirst = decorateInlineReviewTagLine(first);
  const tail = rest.join(newline);
  const combined = tail ? `${decoratedFirst}${newline}${tail}` : decoratedFirst;
  return decorateDetailsSummaries(combined);
}

function stripLeadingMergeRiskEmoji(candidate: string): string {
  for (const emoji of Object.values(MERGE_RISK_LEVEL_EMOJI)) {
    if (candidate.startsWith(emoji)) {
      return candidate.slice(emoji.length).trimStart();
    }
  }
  return candidate;
}

export function detectMergeRiskLevelWord(
  line: string,
): "minimal" | "moderate" | "high" | null {
  const candidate = stripLeadingMergeRiskEmoji(
    line.replace(/\*\*/g, "").replace(/^[-*:]?\s*/, ""),
  );
  for (const { word, pattern } of MERGE_RISK_LEVEL_WORDS) {
    if (pattern.test(candidate)) {
      return word;
    }
  }
  return null;
}

function decorateMergeRiskFirstLine(line: string): string {
  const level = detectMergeRiskLevelWord(line);
  if (!level) {
    return line;
  }
  const emoji = MERGE_RISK_LEVEL_EMOJI[level];
  if (line.trimStart().startsWith(emoji)) {
    return line;
  }
  return `${emoji} ${line.trimStart()}`;
}

/** Runner decoration for the code-review review body (merge risk line). */
export function decorateCodeReviewBody(body: string): string {
  const sectionMatch = body.match(
    /(## Merge risk[:\s]*\n)([\s\S]*?)(?=\n## |\n$|$)/i,
  );
  if (!sectionMatch) {
    return body;
  }
  const header = sectionMatch[1];
  const sectionBody = sectionMatch[2];
  const lines = sectionBody.split("\n");
  let decorated = false;
  const newLines = lines.map((line) => {
    if (decorated || line.trim().length === 0) {
      return line;
    }
    decorated = true;
    return decorateMergeRiskFirstLine(line);
  });
  const newSection = header + newLines.join("\n");
  return body.replace(sectionMatch[0], newSection);
}
