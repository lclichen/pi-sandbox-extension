/**
 * Configuration loading.
 *
 * Mirrors pi's sandbox extension pattern: merge defaults <- global <- project
 * <- env, so users can configure once globally and override per project.
 *
 *   global:  ~/.pi/agent/extensions/sandbox-platform.json
 *   project: <cwd>/.pi/sandbox-platform.json
 *   env:     SANDBOX_PLATFORM_URL, SANDBOX_PLATFORM_TOKEN,
 *            SANDBOX_PLATFORM_USERNAME, SANDBOX_CONTAINER
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PlatformConfig {
  /** Base URL of the sandbox platform, e.g. https://sandbox.corp.com (no trailing slash). */
  url: string;
  /** Access token (JWT). Absent until login. */
  token?: string;
  /** Refresh token, persisted so sessions survive restarts. */
  refreshToken?: string;
  /** Long-lived API key (sk_...). When set, used instead of the JWT and the
   * refresh flow is skipped (keys do not expire). */
  apiKey?: string;
  /** Username last logged in (for display). */
  username?: string;
  /** Default container id to connect on startup (optional). */
  containerId?: number;
}

const DEFAULTS: PlatformConfig = {
  url: "http://localhost:3000",
};

function readJsonSafe(path: string): Partial<PlatformConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`[sandbox-platform] Could not parse ${path}: ${e}`);
    return {};
  }
}

let cached: PlatformConfig | undefined;

function globalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "sandbox-platform.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "sandbox-platform.json");
}

/** Load merged config. Env vars take precedence. */
export function loadConfig(cwd: string): PlatformConfig {
  if (cached) return cached;
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);
  const merged: PlatformConfig = {
    ...DEFAULTS,
    ...readJsonSafe(globalPath),
    ...readJsonSafe(projectPath),
  };
  if (process.env.SANDBOX_PLATFORM_URL) merged.url = process.env.SANDBOX_PLATFORM_URL.replace(/\/$/, "");
  if (process.env.SANDBOX_PLATFORM_TOKEN) merged.token = process.env.SANDBOX_PLATFORM_TOKEN;
  if (process.env.SANDBOX_API_KEY) merged.apiKey = process.env.SANDBOX_API_KEY;
  if (process.env.SANDBOX_PLATFORM_USERNAME) merged.username = process.env.SANDBOX_PLATFORM_USERNAME;
  if (process.env.SANDBOX_CONTAINER) merged.containerId = Number.parseInt(process.env.SANDBOX_CONTAINER, 10);
  cached = merged;
  return merged;
}

/** Persist updated config to the global file (where tokens live). */
export function saveConfig(patch: Partial<PlatformConfig>): void {
  const current = cached ?? { ...DEFAULTS };
  cached = { ...current, ...patch };
  const path = globalConfigPath();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(cached, null, 2));
  } catch (e) {
    console.error(`[sandbox-platform] Could not write ${path}: ${e}`);
  }
}

/** Test-only reset. */
export function resetConfigCache(): void {
  cached = undefined;
}
