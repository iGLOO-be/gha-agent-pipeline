/** @typedef {'issue' | 'pr'} CommandTarget */

/** @typedef {{ id: string, slash: string, extends: string, enabled: boolean, targets: CommandTarget[], access?: string[] }} DispatchCommand */

const BUILTIN_PHASES = [
  "plan",
  "implement",
  "yolo",
  "ci-fix",
  "review-fix",
  "ask",
  "code-review",
];

const SLASH_TOKEN = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = new Set(["fix"]);

/** @param {string} phase */
function defaultTargets(phase) {
  if (phase === "review-fix" || phase === "code-review") return ["pr"];
  if (phase === "ask") return ["issue", "pr"];
  return ["issue"];
}

/**
 * Lightweight YAML parser for the `commands:` section of agent.config.yml.
 * @param {string} yaml
 * @returns {DispatchCommand[]}
 */
function parseAgentCommandsFromYaml(yaml) {
  /** @type {Map<string, DispatchCommand>} */
  const byId = new Map();
  for (const phase of BUILTIN_PHASES) {
    byId.set(phase, {
      id: phase,
      slash: phase,
      extends: phase,
      enabled: true,
      targets: defaultTargets(phase),
    });
  }

  const lines = yaml.split("\n");
  let inCommands = false;
  /** @type {string | null} */
  let currentKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (/^commands:\s*(\|\s*)?$/.test(line)) {
      inCommands = true;
      currentKey = null;
      continue;
    }
    if (!inCommands) continue;
    if (/^[^\s#]/.test(line)) {
      inCommands = false;
      currentKey = null;
      continue;
    }

    const keyMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      if (!byId.has(currentKey)) {
        byId.set(currentKey, {
          id: currentKey,
          slash: currentKey,
          extends: currentKey,
          enabled: true,
          targets: ["issue"],
        });
      }
      continue;
    }

    if (!currentKey) continue;
    const entry = byId.get(currentKey);
    if (!entry) continue;

    const extendsMatch = line.match(/^ {4}extends:\s*(\S+)/);
    if (extendsMatch) {
      entry.extends = extendsMatch[1].replace(/['"]/g, "");
      entry.targets = defaultTargets(entry.extends);
    }

    const slashMatch = line.match(/^ {4}slash:\s*(.+)$/);
    if (slashMatch) {
      entry.slash = slashMatch[1].trim().replace(/^['"]|['"]$/g, "");
    }

    const enabledMatch = line.match(/^ {4}enabled:\s*(false|true)/);
    if (enabledMatch) {
      entry.enabled = enabledMatch[1] === "true";
    }

    const targetsMatch = line.match(/^ {6}- (issue|pr)\s*$/);
    if (targetsMatch && line.includes("targets")) {
      // handled below via block — skip single-line heuristic
    }

    const targetsLine = line.match(/^ {4}targets:\s*$/);
    if (targetsLine) {
      entry.targets = [];
    }

    const targetItem = line.match(/^ {6}- (issue|pr)\s*$/);
    if (
      targetItem &&
      Array.isArray(entry.targets) &&
      entry.targets.length === 0
    ) {
      // will collect in subsequent lines — use simple re-scan
    }
  }

  // Second pass for targets arrays
  inCommands = false;
  currentKey = null;
  /** @type {CommandTarget[] | null} */
  let collectingTargets = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (/^commands:\s*/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (/^[^\s#]/.test(line)) {
      inCommands = false;
      continue;
    }
    const keyMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      collectingTargets = null;
      continue;
    }
    if (!currentKey) continue;
    const entry = byId.get(currentKey);
    if (!entry) continue;

    if (/^ {4}targets:\s*$/.test(line)) {
      collectingTargets = [];
      entry.targets = collectingTargets;
      continue;
    }
    if (collectingTargets) {
      const item = line.match(/^ {6}- (issue|pr)\s*$/);
      if (item) {
        collectingTargets.push(/** @type {CommandTarget} */ (item[1]));
        continue;
      }
      if (!/^ {6}/.test(line)) {
        collectingTargets = null;
      }
    }

    const accessBlock = line.match(/^ {4}author_associations:\s*$/);
    if (accessBlock) {
      entry.access = [];
    }
    if (entry.access && /^ {6}- /.test(line)) {
      const assoc = line.match(/^ {6}- (\S+)/);
      if (assoc) entry.access.push(assoc[1]);
    }
  }

  for (const entry of byId.values()) {
    if (!BUILTIN_PHASES.includes(entry.extends) && entry.id === entry.extends) {
      throw new Error(
        `Command "${entry.id}" in agent.config.yml must declare extends`,
      );
    }
    if (!SLASH_TOKEN.test(entry.slash)) {
      throw new Error(`Invalid slash token for command "${entry.id}"`);
    }
    if (RESERVED.has(entry.slash)) {
      throw new Error(`Slash "${entry.slash}" is reserved`);
    }
  }

  const slashSeen = new Map();
  for (const entry of byId.values()) {
    if (!entry.enabled) continue;
    const prev = slashSeen.get(entry.slash);
    if (prev) {
      throw new Error(`Duplicate slash /agent ${entry.slash}`);
    }
    slashSeen.set(entry.slash, entry.id);
  }

  return [...byId.values()];
}

/**
 * @param {string} body
 * @returns {{ slash: string, args: string } | null}
 */
function parseAgentSlashInvocation(body) {
  const trimmed = (body || "").trim();
  const match = trimmed.match(/^\/agent\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { slash: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

/**
 * @param {string} body
 * @param {DispatchCommand[]} commands
 * @returns {{ command: DispatchCommand, args: string } | null}
 */
function resolveSlashCommand(body, commands) {
  const parsed = parseAgentSlashInvocation(body);
  if (!parsed) return null;
  if (parsed.slash === "fix") return null;
  const enabled = commands.filter((c) => c.enabled);
  const command = enabled.find((c) => c.slash === parsed.slash);
  if (!command) return null;
  return { command, args: parsed.args };
}

module.exports = {
  BUILTIN_PHASES,
  parseAgentCommandsFromYaml,
  parseAgentSlashInvocation,
  resolveSlashCommand,
};
