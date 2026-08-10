/**
 * pi sandbox-platform extension.
 *
 * Connects the pi coding agent to a centralized Apptainer sandbox management
 * platform and routes the built-in tools (read, write, edit, bash, grep, find,
 * ls) into the selected container via the platform's REST relay. The platform
 * is the middleman: every tool operation is forwarded to
 *   /api/v1/containers/:id/tools/*
 * which executes it inside the Apptainer instance (SSH or apptainer CLI on the
 * server side) and returns the result.
 *
 * Usage:
 *   pi -e ./pi-sandbox-extension                          # then /sandbox-login
 *   pi -e ./pi-sandbox-extension --sandbox-container 12   # auto-connect id 12
 *
 * This follows pi's gondolin/ssh example patterns: override the built-in tools
 * with the same name, and supply operations backed by the remote system.
 *
 * Install for auto-discovery:
 *   cp -R pi-sandbox-extension ~/.pi/agent/extensions/pi-sandbox-extension
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type GrepToolInput,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { makeClient, ensureAuthenticated, ensureContainer, getState, setState } from "./lib/auth.ts";
import { createContainerAutocompleteProvider } from "./lib/autocomplete.ts";
import {
  createPlatformBashOps,
  createPlatformEditOps,
  createPlatformLsOps,
  createPlatformReadOps,
  createPlatformWriteOps,
  GUEST_WORKSPACE,
  platformFind,
  platformGrep,
} from "./lib/operations.ts";
import { registerCommands } from "./lib/commands.ts";

export default function (pi: ExtensionAPI) {
  // A CLI flag to pin a container id on startup.
  pi.registerFlag("sandbox-container", {
    description: "Container id to connect to on startup",
    type: "string",
  });

  registerCommands(pi);

  // Hold local tool instances so we can fall back to host execution when no
  // container is connected (lets the extension load harmlessly offline).
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localGrep = createGrepTool(localCwd);

  // Resolve the client/container on session_start so the first user prompt can
  // use the routed tools.
  pi.on("session_start", async (_event, ctx) => {
    const { client, config } = makeClient(ctx.cwd);
    setState({ client, config, containerId: undefined, instanceName: undefined });
    // `@` file completion reads container files when a container is connected
    // (wraps the built-in local-fd provider; delegates when not connected).
    ctx.ui.addAutocompleteProvider((current) =>
      createContainerAutocompleteProvider(current, () => {
        const st = getState();
        return st && st.containerId !== undefined
          ? { client: st.client, containerId: st.containerId }
          : undefined;
      }),
    );
    if (!(await ensureAuthenticated(client, ctx))) return;
    const id = await ensureContainer(pi, ctx, client);
    if (id) ctx.ui.notify(`Sandbox connected: container ${id}.`, "info");
  });

  pi.on("session_shutdown", async () => {
    setState(undefined);
  });

  // Helper: resolve the active container id, or null to fall back to host.
  async function activeContainerId(ctx: ExtensionContext): Promise<number | null> {
    const st = getState();
    if (!st) return null;
    if (st.containerId) return st.containerId;
    if (!(await ensureAuthenticated(st.client, ctx))) return null;
    const id = await ensureContainer(pi, ctx, st.client);
    return id ?? null;
  }

  // ---- override built-in tools, routing into the container ----

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createPlatformReadOps(getState()!.client, cid),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createPlatformWriteOps(getState()!.client, cid),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createPlatformEditOps(getState()!.client, cid),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createPlatformBashOps(getState()!.client, cid),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localLs.execute(id, params, signal, onUpdate);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createPlatformLsOps(getState()!.client, cid),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localFind.execute(id, params, signal, onUpdate);
      const st = getState()!;
      const results = await platformFind(st.client, cid, {
        pattern: params.pattern,
        path: params.path,
        limit: params.limit,
      });
      const { content } = truncateHead(results.join("\n"));
      return {
        content: [{ type: "text", text: content || "No matches" }],
      };
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params: GrepToolInput, _signal, _onUpdate, ctx) {
      const cid = await activeContainerId(ctx);
      if (!cid) return localGrep.execute(_id, params, _signal, _onUpdate);
      const st = getState()!;
      const output = await platformGrep(st.client, cid, {
        pattern: params.pattern,
        path: params.path,
        glob: params.glob,
        literal: params.literal,
        ignoreCase: params.ignoreCase,
        context: params.context,
        limit: params.limit,
      });
      const { content } = truncateHead(output);
      return {
        content: [{ type: "text", text: content || "No matches found" }],
      };
    },
  });

  // Route user `!`/`!!` shell commands into the container too.
  pi.on("user_bash", async (_event, ctx) => {
    const st = getState();
    if (!st?.containerId) return; // fall back to local
    return { operations: createPlatformBashOps(st.client, st.containerId) };
  });

  // Rewrite the system prompt's cwd to the guest workspace when connected.
  pi.on("before_agent_start", async (event, ctx) => {
    const st = getState();
    if (!st?.containerId) return;
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (sandbox platform container ${st.containerId}; platform ${st.client.url})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });

  // Keep a persistent visible indicator that tool calls run in the remote
  // container, refreshed every turn so it never disappears during a session.
  pi.on("turn_start", async (_event, ctx) => {
    const st = getState();
    if (!st?.containerId) return;
    ctx.ui.setStatus(
      "sandbox",
      ctx.ui.theme.fg("accent", `🔒 sandbox:${GUEST_WORKSPACE} (container ${st.containerId} · remote)`),
    );
  });
}
