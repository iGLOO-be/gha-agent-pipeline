import { loadAgentConfig, type AgentConfig } from "../config.js";
import { listCommands, validateCommandRegistry } from "./resolve.js";

export function formatListCommandsJson(config?: AgentConfig): string {
  const resolved = config ?? loadAgentConfig();
  validateCommandRegistry(resolved);
  return JSON.stringify(listCommands(resolved), null, 2);
}

async function main() {
  const format = process.argv.includes("--format")
    ? process.argv[process.argv.indexOf("--format") + 1]
    : "json";

  if (format !== "json") {
    console.error("Only --format json is supported");
    process.exit(1);
  }

  console.log(formatListCommandsJson());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
