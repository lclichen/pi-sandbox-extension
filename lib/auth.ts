/**
 * Auth + connection state for the extension.
 *
 * Holds the resolved PlatformClient and the currently connected container id.
 * Both are resolved lazily: the first tool call or `session_start` triggers
 * login (from cached token) and container selection.
 */
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PlatformClient, PlatformError } from "./client.ts";
import { loadConfig, type PlatformConfig } from "./config.ts";
import { REMOTE_WORKSPACE } from "./constants.ts";
import { syncWorkspaceToContainer } from "./sync.ts";

export interface ConnectionState {
  client: PlatformClient;
  config: PlatformConfig;
  containerId: number | undefined;
  instanceName: string | undefined;
}

let state: ConnectionState | undefined;

export function getState(): ConnectionState | undefined {
  return state;
}

export function setState(next: ConnectionState | undefined): void {
  state = next;
}

/** Build a client from config (no I/O). */
export function makeClient(cwd: string): { client: PlatformClient; config: PlatformConfig } {
  const config = loadConfig(cwd);
  return { client: new PlatformClient(config), config };
}

/** Ensure we are authenticated; verify the token via /me. */
export async function ensureAuthenticated(
  client: PlatformClient,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (!client.config.token) {
    ctx.ui.notify("Not logged in. Run /sandbox-login first.", "warning");
    return false;
  }
  try {
    await client.me();
    return true;
  } catch (err) {
    if (err instanceof PlatformError && err.status === 401) {
      ctx.ui.notify("Session expired. Run /sandbox-login again.", "warning");
    } else {
      ctx.ui.notify(`Platform unreachable: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return false;
  }
}

/** Resolve the container to connect to: flag -> config -> prompt the user. */
export async function ensureContainer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  client: PlatformClient,
): Promise<number | undefined> {
  if (state?.containerId) return state.containerId;

  const config = client.config;
  // 1. CLI flag wins.
  const flag = pi.getFlag("sandbox-container") as string | undefined;
  if (flag) {
    const id = Number.parseInt(flag, 10);
    if (!Number.isNaN(id)) return setContainer(ctx, client, id);
  }
  // 2. Config default.
  if (config.containerId) return setContainer(ctx, client, config.containerId);
  // 3. Pick an existing running container, or auto-create one if none exists.
  try {
    const containers = await client.listContainers();
    const running = containers.filter((c) => c.status === "running");
    if (running.length === 1) return setContainer(ctx, client, running[0].id);
    if (running.length > 1) {
      const choice = await ctx.ui.select(
        "Select a container to connect:",
        running.map((c) => `${c.id}: ${c.name}`),
      );
      if (!choice) return undefined;
      const id = Number.parseInt(choice.split(":")[0], 10);
      return setContainer(ctx, client, id);
    }
    // No running container: auto-provision one from the first public image.
    return autoCreateContainer(ctx, client);
  } catch (err) {
    ctx.ui.notify(`Could not list containers: ${err instanceof Error ? err.message : String(err)}`, "error");
    return undefined;
  }
}

/**
 * Auto-provision a container when the user has none running. Uses the first
 * public image and that image's default resources, so the user can start
 * working immediately after login without manual setup. The local project is
 * then synced into the container's /workspace so the agent sees the same
 * files as the user.
 */
async function autoCreateContainer(
  ctx: ExtensionContext,
  client: PlatformClient,
): Promise<number | undefined> {
  try {
    const images = await client.listImages();
    if (images.length === 0) {
      ctx.ui.notify("No public images available to create a container from.", "warning");
      return undefined;
    }
    const image = images[0];
    const defaults = image.default_resources;
    ctx.ui.setStatus(
      "sandbox",
      ctx.ui.theme.fg("accent", `Sandbox: creating container from ${image.name}…`),
    );
    const created = await client.createContainer({
      imageId: image.id,
      name: `auto-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
      cpu: defaults?.cpu,
      memoryMb: defaults?.memoryMb,
      diskGb: defaults?.diskGb,
    });
    ctx.ui.notify(`Auto-created container #${created.id} from ${image.name}.`, "info");
    // Seed the container's /workspace with the local project.
    await syncWorkspaceToContainer(client, created.id, ctx.cwd, {
      onFile: (rel, index, total) =>
        ctx.ui.setStatus("sandbox", `Sandbox: syncing ${index}/${total} ${rel}`),
    });
    ctx.ui.notify("Local project synced into the container's /workspace.", "info");
    return setContainer(ctx, client, created.id);
  } catch (err) {
    ctx.ui.notify(`Auto-create failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return undefined;
  }
}

async function setContainer(
  ctx: ExtensionContext,
  client: PlatformClient,
  id: number,
): Promise<number> {
  try {
    const info = await client.connectContainer(id);
    if (!state) throw new Error("Connection state missing");
    state.containerId = id;
    state.instanceName = info.instanceName;
    ctx.ui.setStatus(
      "sandbox",
      ctx.ui.theme.fg("accent", `🔒 sandbox:${REMOTE_WORKSPACE} (container ${id} · remote)`),
    );
    return id;
  } catch (err) {
    ctx.ui.notify(`Connect failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return id;
  }
}
