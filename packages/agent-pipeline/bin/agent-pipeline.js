#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const phases = new Set([
  "plan",
  "implement",
  "yolo",
  "ci-fix",
  "review-fix",
  "ask",
]);

const phase = process.argv[2];
if (!phase || !phases.has(phase)) {
  console.error(
    "Usage: agent-pipeline <plan|implement|yolo|ci-fix|review-fix|ask>",
  );
  process.exit(1);
}

const binDir = dirname(fileURLToPath(import.meta.url));
const entry = resolve(binDir, "..", "src", `${phase}.ts`);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(
  process.execPath,
  [tsxCli, entry, ...process.argv.slice(3)],
  {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  },
);

process.exit(result.status ?? 1);
