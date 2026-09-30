#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const binDir = dirname(fileURLToPath(import.meta.url));
const entry = resolve(binDir, "..", "src", "cli.ts");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(
  process.execPath,
  [tsxCli, entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  },
);

process.exit(result.status ?? 1);
