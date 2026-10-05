/**
 * Formats the reply posted when a syntactically valid `/agent <slash>` invocation
 * was received on an issue or PR comment but could not be dispatched because the
 * slash is unknown, points at a disabled command, or is not allowed on the target.
 *
 * Keep this file plain CJS so it can be required from the dispatch
 * `actions/github-script` step without any build step.
 *
 * @typedef {'issue' | 'pr'} CommandTarget
 * @typedef {{ id?: string, slash: string, extends?: string, enabled?: boolean, targets?: CommandTarget[] }} DispatchCommand
 */

/** @param {CommandTarget | string} target */
function targetKey(target) {
  return target === "pr" ? "pr" : "issue";
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  /** @type {number[]} */
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    /** @type {number[]} */
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Enabled slash tokens that can run on the given target, including reserved
 * slash tokens (e.g. `fix` on a PR) that are not part of the parsed commands.
 *
 * @param {{ target: CommandTarget | string, commands?: DispatchCommand[], reservedSlashTokens?: string[] }} input
 * @returns {string[]}
 */
function collectAvailableSlashTokens({
  target,
  commands,
  reservedSlashTokens = [],
}) {
  const key = targetKey(target);
  /** @type {string[]} */
  const tokens = [];
  for (const command of commands || []) {
    if (!command || !command.enabled) continue;
    if (!Array.isArray(command.targets) || !command.targets.includes(key)) {
      continue;
    }
    tokens.push(command.slash);
  }
  for (const token of reservedSlashTokens) {
    if (token) tokens.push(token);
  }
  return [...new Set(tokens)];
}

/**
 * Best-effort suggestion when the received slash is close to an available one.
 *
 * @param {string} slash
 * @param {string[]} available
 * @returns {string | null}
 */
function findSuggestedSlash(slash, available) {
  if (!slash) return null;
  const needle = String(slash).toLowerCase();
  const maxDistance = needle.length <= 4 ? 1 : 2;
  let best = null;
  let bestRank = Infinity;
  let bestDistance = Infinity;
  for (const candidate of available || []) {
    const value = candidate.toLowerCase();
    const segments = value.split("-");
    const rank =
      value === needle
        ? 0
        : segments[segments.length - 1] === needle
          ? 1
          : segments.includes(needle)
            ? 2
            : value.includes(needle) || needle.includes(value)
              ? 3
              : 4;
    const distance = rank === 4 ? levenshtein(value, needle) : 0;
    if (rank === 4 && distance > maxDistance) continue;
    if (rank < bestRank || (rank === bestRank && distance < bestDistance)) {
      bestRank = rank;
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * @param {{
 *   slash: string,
 *   target: CommandTarget | string,
 *   commands?: DispatchCommand[],
 *   reservedSlashTokens?: string[],
 *   reason?: 'unknown' | 'disabled' | 'wrong-target'
 * }} input
 * @returns {string}
 */
function formatUnknownAgentCommandReply({
  slash,
  target,
  commands,
  reservedSlashTokens = [],
  reason = "unknown",
}) {
  const key = targetKey(target);
  const label = key === "pr" ? "pull request" : "issue";
  const available = collectAvailableSlashTokens({
    target: key,
    commands,
    reservedSlashTokens,
  });
  // The token comes from an untrusted comment body: strip backticks and angle
  // brackets so it cannot break out of the inline code span, render as HTML, or
  // become a live mention in the reply.
  const token = slash ? String(slash).replace(/[`<>]/g, "") : "?";

  /** @type {string[]} */
  const lines = [];
  if (reason === "wrong-target") {
    lines.push(
      `⚠️ **\`/agent ${token}\` was not executed** — this command is not available on ${label} comments.`,
    );
  } else if (reason === "disabled") {
    lines.push(
      `⚠️ **\`/agent ${token}\` was not executed** — this command is disabled in \`agent.config.yml\`.`,
    );
  } else {
    lines.push(
      `⚠️ **\`/agent ${token}\` was not executed** — unknown command.`,
    );
  }

  const suggestion =
    reason === "unknown" ? findSuggestedSlash(token, available) : null;
  if (suggestion) {
    lines.push("");
    lines.push(`Did you mean \`/agent ${suggestion}\`?`);
  }

  if (available.length > 0) {
    lines.push("");
    lines.push(
      `**Available commands on this ${label}:** ${available
        .map((value) => `\`/agent ${value}\``)
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Why a syntactically valid `/agent <slash>` could not be dispatched, when the
 * slash is neither resolvable nor explicitly flagged by the caller.
 *
 * Returns `'disabled'` when the slash is declared in `commands` but disabled,
 * `undefined` when it does not exist at all (reported as `unknown`).
 *
 * @param {{ slash: string, commands?: DispatchCommand[] }} input
 * @returns {'disabled' | undefined}
 */
function unknownCommandReason({ slash, commands }) {
  if (!slash) return undefined;
  const disabled = (commands || []).some(
    (command) => command && command.slash === slash && !command.enabled,
  );
  return disabled ? "disabled" : undefined;
}

module.exports = {
  collectAvailableSlashTokens,
  findSuggestedSlash,
  formatUnknownAgentCommandReply,
  unknownCommandReason,
};
