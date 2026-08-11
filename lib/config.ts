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
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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
  // ---- LLM (LiteLLM) integration ----
  /** Provider name to register with pi (what shows in /model). Defaults to "amedac.ai". */
  llmProvider?: string;
  /** Cached LiteLLM virtual-key plaintext, so we don't reveal on every startup. */
  llmVirtualKey?: string;
  /** Platform-side id of the cached virtual key (for revocation/refresh). */
  llmKeyId?: number;
  /** LiteLLM base URL the agent should drive LLM traffic to (from /llm/me/endpoint). */
  llmEndpoint?: string;
}

const DEFAULTS: PlatformConfig = {
  url: "http://localhost:3000",
  llmProvider: "amedac.ai",
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

/**
 * Persist updated config to the global file (where tokens live).
 *
 * The file holds JWT/refresh tokens, API keys, and (when LLM is enabled) the
 * LiteLLM virtual key plaintext, so it is written with mode 0600 on POSIX.
 * (Windows ignores the mode; the directory ACL governs access there.)
 */
export function saveConfig(patch: Partial<PlatformConfig>): void {
  const current = cached ?? { ...DEFAULTS };
  cached = { ...current, ...patch };
  const path = globalConfigPath();
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(cached, null, 2), { mode: 0o600 });
    // Re-assert in case the file already existed with a looser mode (open+w
    // preserves the existing mode on some platforms).
    try {
      chmodSync(path, 0o600);
    } catch {
      // chmod is best-effort (e.g. unsupported on some Windows setups).
    }
  } catch (e) {
    console.error(`[sandbox-platform] Could not write ${path}: ${e}`);
  }
}

/** Test-only reset. */
export function resetConfigCache(): void {
  cached = undefined;
}
