import { loadAgentConfig } from "./config.js";
import { formatListCommandsJson } from "./commands/list-cli.js";
import { resolveCommand } from "./commands/resolve.js";

async function route() {
  const commandId = process.argv[2];

  if (!commandId) {
    console.error(
      "Usage: agent-pipeline <command-id|list-commands> [args…]\n" +
        "Built-in commands: plan, implement, yolo, ci-fix, review-fix, ask, code-review",
    );
    process.exit(1);
  }

  if (commandId === "list-commands") {
    const formatIdx = process.argv.indexOf("--format");
    const format = formatIdx >= 0 ? process.argv[formatIdx + 1] : "json";
    if (format !== "json") {
      console.error("Only --format json is supported");
      process.exit(1);
    }
    console.log(formatListCommandsJson());
    return;
  }

  const config = loadAgentConfig();
  const resolved = resolveCommand(commandId, config);
  if (!resolved.enabled) {
    throw new Error(`Command "${commandId}" is disabled`);
  }

  process.env.AGENT_COMMAND_ID = resolved.id;
  const args = process.argv.slice(3);
  if (args.length > 0) {
    process.env.AGENT_COMMAND_ARGS = args.join(" ");
  }

  await import(`./${resolved.extends}.js`);
}

void route().catch((error) => {
  console.error(error);
  process.exit(1);
});
