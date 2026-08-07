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

  /** Exchange the refresh token for a new pair. Returns true on success. */
  async refresh(): Promise<boolean> {
    if (!this.config.refreshToken) return false;
    try {
      const res = await fetch(`${this.config.url}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this.config.refreshToken }),
      });
      if (!res.ok) return false;
      const pair = (await res.json()) as { accessToken: string; refreshToken: string };
      this.config.token = pair.accessToken;
      this.config.refreshToken = pair.refreshToken;
      saveConfig({ token: pair.accessToken, refreshToken: pair.refreshToken });
      return true;
    } catch {
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
