/**
 * Platform REST client.
 *
 * Thin fetch wrapper over the sandbox platform API. Automatically attaches the
 * JWT bearer token and transparently refreshes it once on 401. All tool
 * operations are POSTed with base64 payloads to stay binary-safe.
 */
import type { PlatformConfig } from "./config.ts";
import { saveConfig } from "./config.ts";

export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PlatformClient {
  /** Diagnoses the most recent refresh failure, for surfacing to the user. */
  lastRefreshDiagnosis: "ok" | "expired" | "unreachable" | "no_refresh_token" = "ok";

  constructor(private readonly config: PlatformConfig) {}

  get url(): string {
    return this.config.url;
  }

  private authHeaders(): Record<string, string> {
    // API key takes precedence: it is long-lived and never refreshed.
    if (this.config.apiKey) return { "X-API-Key": this.config.apiKey };
    return this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {};
  }

  async request<T = unknown>(
    path: string,
    opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { method = "GET", body, signal } = opts;
    const doFetch = async (): Promise<Response> =>
      fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });

    let res = await doFetch();
    // Only attempt JWT refresh when NOT using an API key (keys don't expire).
    if (res.status === 401 && !this.config.apiKey && this.config.refreshToken) {
      const refreshed = await this.refresh();
      if (refreshed) {
        res = await doFetch();
      }
    }
    if (!res.ok) {
      let payload: { code?: string; message?: string; details?: unknown } = {};
      try {
        payload = await res.json();
      } catch {
        // non-JSON error
      }
      throw new PlatformError(
        res.status,
        payload.code ?? "http_error",
        payload.message ?? `HTTP ${res.status}`,
        payload.details,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Exchange the refresh token for a new pair. Returns true on success. On
   * failure, sets {@link lastRefreshDiagnosis} so callers can tell a network
   * hiccup ("platform unreachable, retry") apart from an expired session
   * ("re-login required") — both used to collapse to a single `false` with no
   * diagnostic, which left users guessing.
   */
  async refresh(): Promise<boolean> {
    if (!this.config.refreshToken) {
      this.lastRefreshDiagnosis = "no_refresh_token";
      return false;
    }
    try {
      const res = await fetch(`${this.config.url}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this.config.refreshToken }),
      });
      if (!res.ok) {
        // 401/403 from /auth/refresh means the refresh token itself is invalid
        // or revoked — the user must re-login. Other non-2xx (5xx) is treated
        // as a transient platform issue.
        this.lastRefreshDiagnosis = res.status === 401 || res.status === 403 ? "expired" : "unreachable";
        return false;
      }
      const pair = (await res.json()) as { accessToken: string; refreshToken: string };
      this.config.token = pair.accessToken;
      this.config.refreshToken = pair.refreshToken;
      saveConfig({ token: pair.accessToken, refreshToken: pair.refreshToken });
      this.lastRefreshDiagnosis = "ok";
      return true;
    } catch {
      // Network error (fetch rejected) — distinct from an auth rejection.
      this.lastRefreshDiagnosis = "unreachable";
      return false;
    }
  }

  // ---- auth ----
  async login(username: string, password: string): Promise<void> {
    const res = await this.request<{
      accessToken: string;
      refreshToken: string;
      user: { username: string };
    }>("/api/v1/auth/login", { method: "POST", body: { username, password } });
    this.config.token = res.accessToken;
    this.config.refreshToken = res.refreshToken;
    this.config.username = res.user.username;
    saveConfig({
      token: res.accessToken,
      refreshToken: res.refreshToken,
      username: res.user.username,
    });
  }

  async me(): Promise<{ id: number; username: string; role: string }> {
    const res = await this.request<{ user: { id: number; username: string; role: string } }>("/api/v1/auth/me");
    return res.user;
  }

  // ---- API keys ----
  /** Create a long-lived API key. Returns the plaintext secret once. */
  async createApiKey(name: string): Promise<{ id: number; key: string; name: string; key_prefix: string }> {
    return this.request("/api/v1/auth/api-keys", { method: "POST", body: { name } });
  }

  async listApiKeys(): Promise<Array<{ id: number; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>> {
    const res = await this.request<{ apiKeys: Array<{ id: number; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }> }>("/api/v1/auth/api-keys");
    return res.apiKeys;
  }

  async revokeApiKey(id: number): Promise<void> {
    await this.request(`/api/v1/auth/api-keys/${id}`, { method: "DELETE" });
  }

  // ---- images (public listing, for choosing a base when creating a container) ----
  async listImages(): Promise<Array<{ id: number; name: string; display_name: string; default_resources?: { cpu: number; memoryMb: number; diskGb: number } | null }>> {
    const res = await this.request<{ images: Array<{ id: number; name: string; display_name: string; default_resources?: { cpu: number; memoryMb: number; diskGb: number } | null }> }>("/api/v1/images");
    return res.images;
  }

  // ---- LLM (LiteLLM) integration ----
  // The platform manages LiteLLM users/keys on the user's behalf. These let the
  // extension auto-provision the agent's LLM provider after login, so the user
  // never has to copy a virtual key manually.

  /** My LLM access status. binding is null when access hasn't been granted. */
  async getMyLlmStatus(): Promise<{
    binding: {
      platform_user_id: number;
      litellm_user_id: string;
      max_budget: number;
      budget_duration: string | null;
      models: string[] | null;
      revoked_at: string | null;
    } | null;
    litellm: { spend?: number; max_budget?: number | null } | null;
  }> {
    return this.request("/api/v1/llm/me");
  }

  async listMyLlmKeys(): Promise<Array<{
    id: number;
    name: string;
    key_prefix: string;
    models: string[] | null;
    max_budget: number | null;
    created_at: string;
    revoked_at: string | null;
  }>> {
    const res = await this.request<{ keys: Array<{ id: number; name: string; key_prefix: string; models: string[] | null; max_budget: number | null; created_at: string; revoked_at: string | null }> }>("/api/v1/llm/me/keys");
    return res.keys;
  }

  /** Decrypt + return a key's plaintext (sensitive; the platform audits this). */
  async revealMyLlmKey(id: number): Promise<{ id: number; plaintext: string }> {
    return this.request(`/api/v1/llm/me/keys/${id}/reveal`, { method: "POST" });
  }

  /** The base URL + usage instructions for driving LLM traffic directly. */
  async getLlmEndpoint(): Promise<{ baseUrl: string; instructions: string }> {
    return this.request("/api/v1/llm/me/endpoint");
  }

  async listLlmModels(): Promise<Array<{ id: string; owned_by?: string }>> {
    const res = await this.request<{ models: Array<{ id: string; owned_by?: string }> }>("/api/v1/llm/models");
    return res.models;
  }

  // ---- containers ----
  async listContainers(): Promise<Array<{ id: number; name: string; status: string; instance_name: string | null }>> {
    const res = await this.request<{ containers: Array<{ id: number; name: string; status: string; instance_name: string | null }> }>(
      "/api/v1/containers",
    );
    return res.containers;
  }

  async createContainer(input: {
    imageId: number;
    name: string;
    cpu?: number;
    memoryMb?: number;
    diskGb?: number;
  }): Promise<{ id: number }> {
    const res = await this.request<{ id: number }>("/api/v1/containers", { method: "POST", body: input });
    return res;
  }

  async connectContainer(id: number): Promise<{ sessionId: number; instanceName: string }> {
    const res = await this.request<{ sessionId: number; instanceName: string }>(
      `/api/v1/containers/${id}/connect`,
    );
    return res;
  }

  // ---- tool operations (relay into the container) ----
  async toolRead(containerId: number, path: string): Promise<Buffer> {
    const res = await this.request<{ contentBase64: string }>(
      `/api/v1/containers/${containerId}/tools/read`,
      { method: "POST", body: { path } },
    );
    return Buffer.from(res.contentBase64, "base64");
  }

  async toolWrite(containerId: number, path: string, content: Buffer): Promise<void> {
    await this.request(`/api/v1/containers/${containerId}/tools/write`, {
      method: "POST",
      body: { path, content: content.toString("base64") },
    });
  }

  async toolEdit(
    containerId: number,
    path: string,
    oldText: string,
    newText: string,
  ): Promise<{ applied: boolean }> {
    return this.request(`/api/v1/containers/${containerId}/tools/edit`, {
      method: "POST",
      body: { path, oldText, newText },
    });
  }

  async toolAccess(containerId: number, path: string): Promise<boolean> {
    const res = await this.request<{ exists: boolean }>(
      `/api/v1/containers/${containerId}/tools/access?path=${encodeURIComponent(path)}`,
    );
    return res.exists;
  }

  async toolStat(containerId: number, path: string): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    mtimeMs: number;
  }> {
    return this.request(`/api/v1/containers/${containerId}/tools/stat?path=${encodeURIComponent(path)}`);
  }

  async toolLs(containerId: number, path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; size: number }>> {
    const res = await this.request<{ entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; size: number }> }>(
      `/api/v1/containers/${containerId}/tools/ls?path=${encodeURIComponent(path)}`,
    );
    return res.entries;
  }

  async toolBash(
    containerId: number,
    command: string,
    opts: { cwd?: string; timeout?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return this.request(`/api/v1/containers/${containerId}/tools/bash`, {
      method: "POST",
      body: { command, cwd: opts.cwd, timeout: opts.timeout },
    });
  }

  /**
   * Run a bash command with LIVE output via the SSE endpoint
   * (POST /tools/bash/stream). Output chunks are delivered to `onData` as
   * they arrive; the promise resolves with the exit outcome when the stream
   * ends (`event: end`). Non-2xx responses (including 404/405 from platforms
   * without the stream endpoint) reject with a PlatformError so callers can
   * fall back to the request/response `toolBash`.
   */
  async toolBashStream(
    containerId: number,
    command: string,
    opts: { cwd?: string; timeout?: number; signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {},
  ): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const doFetch = (): Promise<Response> =>
      fetch(`${this.config.url}/api/v1/containers/${containerId}/tools/bash/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({ command, cwd: opts.cwd, timeout: opts.timeout }),
        signal: opts.signal,
      });

    let res = await doFetch();
    // Only attempt JWT refresh when NOT using an API key (keys don't expire).
    if (res.status === 401 && !this.config.apiKey && this.config.refreshToken) {
      const refreshed = await this.refresh();
      if (refreshed) res = await doFetch();
    }
    if (!res.ok) {
      let payload: { code?: string; message?: string } = {};
      try {
        payload = await res.json();
      } catch {
        // non-JSON error
      }
      throw new PlatformError(
        res.status,
        payload.code ?? "http_error",
        payload.message ?? `HTTP ${res.status}`,
      );
    }

    const reader = res.body?.getReader();
    if (!reader) throw new PlatformError(500, "stream_error", "Response body is not a readable stream");
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    return new Promise<{ exitCode: number | null; timedOut: boolean }>((resolveFn, rejectFn) => {
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Process complete SSE blocks (terminated by a blank line).
            let sep = buffer.indexOf("\n\n");
            while (sep >= 0) {
              const block = buffer.slice(0, sep).trim();
              buffer = buffer.slice(sep + 2);
              const event = parseSseEvent(block);
              if (event) {
                if (event.event === "data" && typeof event.data.chunk === "string") {
                  opts.onData?.(Buffer.from(event.data.chunk, "base64"));
                } else if (event.event === "end") {
                  void reader.cancel();
                  resolveFn({
                    exitCode: event.data.timedOut ? null : (Number(event.data.exitCode) || 0),
                    timedOut: Boolean(event.data.timedOut),
                  });
                  return;
                } else if (event.event === "error") {
                  void reader.cancel();
                  // The platform carries the semantic HTTP status/code inside
                  // the error event (SSE headers are already flushed).
                  rejectFn(
                    new PlatformError(
                      Number(event.data.status) || 500,
                      String(event.data.code ?? "stream_error"),
                      String(event.data.message ?? "stream error"),
                    ),
                  );
                  return;
                }
              }
              sep = buffer.indexOf("\n\n");
            }
          }
          // Stream closed without an `end` event — treat as a failure.
          rejectFn(new PlatformError(500, "stream_error", "stream ended without an end event"));
        } catch (err) {
          rejectFn(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  async toolGrep(
    containerId: number,
    params: { pattern: string; path?: string; glob?: string; literal?: boolean; ignoreCase?: boolean; context?: number; limit?: number },
  ): Promise<string> {
    const res = await this.request<{ output: string }>(`/api/v1/containers/${containerId}/tools/grep`, {
      method: "POST",
      body: params,
    });
    return res.output;
  }

  async toolFind(
    containerId: number,
    params: { pattern: string; path?: string; limit?: number },
  ): Promise<string[]> {
    const res = await this.request<{ results: string[] }>(`/api/v1/containers/${containerId}/tools/find`, {
      method: "POST",
      body: params,
    });
    return res.results;
  }
}

/**
 * Parse one SSE block ("event: X\ndata: {...}") into { event, data }.
 * Returns null for heartbeat/empty blocks or malformed JSON.
 */
function parseSseEvent(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}
