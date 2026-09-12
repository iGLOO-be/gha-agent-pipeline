import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AGENT_STATE_DIR = ".agent-state";

function statePath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(AGENT_STATE_DIR, `${safe}.txt`);
}

async function ensureDir(): Promise<void> {
  await mkdir(AGENT_STATE_DIR, { recursive: true });
}

export async function readCacheValue(key: string): Promise<string | null> {
  try {
    const raw = await readFile(statePath(key), "utf8");
    return raw;
  } catch {
    return null;
  }
}

export async function writeCacheValue(
  key: string,
  value: string,
): Promise<void> {
  await ensureDir();
  const path = statePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

export async function readCounter(key: string): Promise<number> {
  const raw = await readCacheValue(key);
  if (raw === null) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function writeCounter(key: string, value: number): Promise<void> {
  await writeCacheValue(key, String(Math.max(0, Math.floor(value))));
}

export function ciRoundCacheKey(prNumber: number): string {
  return `agent-ci-round-${prNumber}`;
}
