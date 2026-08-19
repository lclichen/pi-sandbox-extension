/**
 * Slash commands exposed by the extension.
 *
 *   /sandbox-login   authenticate against the platform (username/password)
 *   /sandbox-status  show current user, container, and connection state
 *   /sandbox-list    list running containers and select one to connect
 *   /sandbox-new     create a new container and connect to it
 *   /sandbox-sync    upload the local project into the container's /workspace
 *   /sandbox-url     print the configured platform URL
 *   /sandbox-apikey  manage long-lived API keys (create / list / revoke / use)
 *   /sandbox-llm     check / refresh the auto-provisioned LLM provider (LiteLLM)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeClient, ensureAuthenticated, getState, setState } from "./auth.ts";
import { PlatformError } from "./client.ts";
import { saveConfig } from "./config.ts";
import { syncWorkspaceToContainer } from "./sync.ts";
import { ensureLlmProvider, refreshLlmProvider } from "./llm.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("sandbox-login", {
    description: "Authenticate with the sandbox platform",
    handler: async (_args, ctx) => {
      const { client, config } = makeClient(ctx.cwd);
      const username = (await ctx.ui.input("Username:", config.username)) ?? "";
      const password = (await ctx.ui.input("Password:")) ?? "";
      if (!username || !password) {
        ctx.ui.notify("Login cancelled.", "info");
        return;
      }
      try {
        await client.login(username, password);
        const me = await client.me();
        setState({ client, config, containerId: undefined, instanceName: undefined }, ctx.cwd);
        ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `Sandbox: logged in as ${me.username}`));
        ctx.ui.notify(
          [`Logged in as ${me.username} (${me.role}).`, "Credentials saved — you won't need to log in again for 7 days."].join("\n"),
          "info",
        );
      } catch (err) {
        const msg =
          err instanceof PlatformError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Login failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-status", {
    description: "Show sandbox platform connection status",
    handler: async (_args, ctx) => {
      const st = getState(ctx.cwd);
      if (!st) {
        ctx.ui.notify("Not connected. Run /sandbox-login.", "info");
        return;
      }
      let role = "?";
      try {
        const me = await st.client.me();
        role = me.role;
        const cred = st.config.apiKey
          ? `API key (${st.config.apiKey.slice(0, 11)}…)`
          : st.config.token
            ? "JWT (saved, auto-refreshes for 7 days)"
            : "none";
        const lines = [
          `Platform: ${st.client.url}`,
          `User: ${me.username} (${role})`,
          `Credential: ${cred}`,
          `Container: ${st.containerId ?? "(none selected)"}`,
          `Instance: ${st.instanceName ?? "(n/a)"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        ctx.ui.notify(`Platform: ${st.client.url} (token invalid or unreachable)`, "warning");
      }
    },
  });

  pi.registerCommand("sandbox-list", {
    description: "List running containers and connect to one",
    handler: async (_args, ctx) => {
      const { client } = makeClient(ctx.cwd);
      if (!(await ensureAuthenticated(client, ctx))) return;
      try {
        const containers = await client.listContainers();
        const running = containers.filter((c) => c.status === "running");
        if (running.length === 0) {
          ctx.ui.notify("No running containers.", "info");
          return;
        }
        const choice = await ctx.ui.select(
          "Connect to container:",
          running.map((c) => `${c.id}: ${c.name}`),
        );
        if (!choice) return;
        const id = Number.parseInt(choice.split(":")[0], 10);
        // Defer to ensureContainer by setting the flag-like state.
        const cur = getState(ctx.cwd);
        if (cur) {
          const info = await client.connectContainer(id);
          cur.containerId = id;
          cur.instanceName = info.instanceName;
          ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `Sandbox: ${info.instanceName} (container ${id})`));
          ctx.ui.notify(`Connected to container ${id}.`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-url", {
    description: "Print the configured sandbox platform URL",
    handler: async (_args, ctx) => {
      const { config } = makeClient(ctx.cwd);
      ctx.ui.notify(`Platform URL: ${config.url}`, "info");
    },
  });

  pi.registerCommand("sandbox-apikey", {
    description: "Manage long-lived API keys (create / list / revoke / use)",
    handler: async (_args, ctx) => {
      const { client } = makeClient(ctx.cwd);
      if (!(await ensureAuthenticated(client, ctx))) return;

      const action = await ctx.ui.select("API keys:", [
        "Create a new key",
        "List my keys",
        "Revoke a key",
        "Use a pasted key now",
      ]);
      if (!action) return;

      try {
        if (action === "Create a new key") {
          const name = (await ctx.ui.input("Key name (label):", "my-key")) ?? "key";
          const created = await client.createApiKey(name);
          // Persist it so subsequent invocations authenticate without login.
          saveConfig({ apiKey: created.key });
          getState(ctx.cwd)?.client && (getState(ctx.cwd)!.client.config.apiKey = created.key);
          ctx.ui.notify(
            [`API key created (shown once — store it now):`, created.key, `prefix: ${created.key_prefix}`].join("\n"),
            "info",
          );
        } else if (action === "List my keys") {
          const keys = await client.listApiKeys();
          if (keys.length === 0) {
            ctx.ui.notify("No API keys.", "info");
            return;
          }
          const lines = keys.map(
            (k) => `${k.key_prefix}  ${k.name}  ${k.revoked_at ? "[revoked]" : k.last_used_at ? `used ${k.last_used_at}` : "unused"}`,
          );
          ctx.ui.notify(["Your API keys:", ...lines].join("\n"), "info");
        } else if (action === "Revoke a key") {
          const keys = (await client.listApiKeys()).filter((k) => !k.revoked_at);
          if (keys.length === 0) {
            ctx.ui.notify("No active keys to revoke.", "info");
            return;
          }
          const choice = await ctx.ui.select(
            "Revoke which key?",
            keys.map((k) => `${k.key_prefix}  ${k.name}`),
          );
          if (!choice) return;
          const target = keys[choice ? keys.findIndex((k) => `${k.key_prefix}  ${k.name}` === choice) : -1];
          if (!target) return;
          await client.revokeApiKey(target.id);
          // If the revoked key is the one in use, clear it.
          if (getState(ctx.cwd)?.client.config.apiKey?.endsWith(target.key_prefix.slice(3))) {
            saveConfig({ apiKey: undefined });
          }
          ctx.ui.notify("Key revoked.", "info");
        } else if (action === "Use a pasted key now") {
          const key = (await ctx.ui.input("Paste API key (sk_...):"))?.trim();
          if (!key) return;
          saveConfig({ apiKey: key });
          const st = getState(ctx.cwd);
          if (st) st.client.config.apiKey = key;
          ctx.ui.notify("API key saved. It will be used for all platform calls.", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-llm", {
    description: "Check or refresh the auto-provisioned LLM provider (LiteLLM)",
    handler: async (_args, ctx) => {
      const { client, config } = makeClient(ctx.cwd);
      if (!(await ensureAuthenticated(client, ctx))) return;

      // Show current status first.
      let statusLines: string[];
      try {
        const status = await client.getMyLlmStatus();
        if (!status.binding || status.binding.revoked_at) {
          ctx.ui.notify(
            "LLM: no access granted on the platform. Ask an admin to enable it, then run /sandbox-llm again.",
            "info",
          );
          return;
        }
        const spend = status.litellm?.spend ?? 0;
        statusLines = [
          `Provider: ${config.llmProvider ?? "amedac.ai"}`,
          `Budget: $${spend.toFixed(4)} / $${status.binding.max_budget.toFixed(2)} (${status.binding.budget_duration ?? "no reset"})`,
          `Models: ${status.binding.models ? status.binding.models.join(", ") : "all"}`,
          `Cached key: ${config.llmVirtualKey ? `${config.llmVirtualKey.slice(0, 12)}… (id ${config.llmKeyId ?? "?"})` : "(none — will reveal on refresh)"}`,
          `Endpoint: ${config.llmEndpoint ?? "(not fetched yet)"}`,
        ];
      } catch (err) {
        if (err instanceof PlatformError && (err.status === 501 || err.status === 503)) {
          ctx.ui.notify("LLM integration is not enabled on this platform.", "warning");
          return;
        }
        ctx.ui.notify(`LLM status check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      const action = await ctx.ui.select(`LLM status — ${statusLines.join(" | ")}`, [
        "Re-register provider (use cached key)",
        "Force refresh (clear cache + re-reveal key)",
      ]);
      if (!action) return;

      try {
        if (action === "Re-register provider (use cached key)") {
          const res = await ensureLlmProvider(pi, ctx, client);
          if (res.ok) {
            ctx.ui.notify(`LLM provider "${res.provider}" registered (${res.modelCount} models). Use /model to select.`, "info");
          } else {
            ctx.ui.notify(`LLM setup skipped: ${res.reason ?? "unknown"}`, "warning");
          }
        } else {
          const res = await refreshLlmProvider(pi, ctx, client);
          if (res.ok) {
            ctx.ui.notify(`LLM provider refreshed: "${res.provider}" (${res.modelCount} models). Use /model to select.`, "info");
          } else {
            ctx.ui.notify(`LLM refresh skipped: ${res.reason ?? "unknown"}`, "warning");
          }
        }
      } catch (err) {
        ctx.ui.notify(`LLM setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-new", {
    description: "Create a new container and connect to it",
    handler: async (_args, ctx) => {
      const { client } = makeClient(ctx.cwd);
      if (!(await ensureAuthenticated(client, ctx))) return;
      try {
        const images = await client.listImages();
        if (images.length === 0) {
          ctx.ui.notify("No public images available.", "warning");
          return;
        }
        const imageChoice = await ctx.ui.select(
          "Base image:",
          images.map((i) => `${i.id}: ${i.display_name} (${i.name})`),
        );
        if (!imageChoice) return;
        const imageId = Number.parseInt(imageChoice.split(":")[0], 10);
        const image = images.find((i) => i.id === imageId)!;
        const name =
          (await ctx.ui.input("Container name:", `box-${new Date().toISOString().slice(0, 10)}`)) ?? `box-${Date.now()}`;
        const created = await client.createContainer({
          imageId,
          name,
          cpu: image.default_resources?.cpu,
          memoryMb: image.default_resources?.memoryMb,
          diskGb: image.default_resources?.diskGb,
        });
        const cur = getState(ctx.cwd);
        if (cur) {
          const info = await client.connectContainer(created.id);
          cur.containerId = created.id;
          cur.instanceName = info.instanceName;
          ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `Sandbox: ${info.instanceName} (container ${created.id})`));
        }
        ctx.ui.notify(`Created and connected to container #${created.id}.`, "info");
      } catch (err) {
        ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-sync", {
    description: "Upload the local project into the container's /workspace",
    handler: async (_args, ctx) => {
      const st = getState(ctx.cwd);
      if (!st?.containerId) {
        ctx.ui.notify("No container connected. Run /sandbox-list or /sandbox-new first.", "warning");
        return;
      }
      try {
        ctx.ui.setStatus("sandbox", "Sandbox: syncing local project → /workspace…");
        const result = await syncWorkspaceToContainer(st.client, st.containerId, ctx.cwd, {
          onFile: (rel, index, total) =>
            ctx.ui.setStatus("sandbox", `Sandbox: syncing ${index}/${total} ${rel}`),
        });
        const mb = (result.bytes / (1024 * 1024)).toFixed(1);
        // Distinguish "uploaded N changed" from "M unchanged (skipped)" so a
        // re-sync with no edits reads clearly instead of "Synced 0 files".
        const uploaded =
          result.failures.length > 0
            ? `Synced ${result.files} files (${mb}MB); ${result.failures.length} failed.`
            : result.unchanged > 0
              ? `Synced ${result.files} changed (${mb}MB); ${result.unchanged} unchanged.`
              : `Synced ${result.files} files (${mb}MB) into /workspace.`;
        ctx.ui.notify(uploaded, result.failures.length > 0 ? "warning" : "info");
      } catch (err) {
        ctx.ui.notify(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
