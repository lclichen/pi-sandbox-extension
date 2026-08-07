/**
 * Platform-backed operation interfaces for pi's built-in tools.
 *
 * Each `create*Ops` function returns an object implementing the corresponding
 * pi operations interface, but instead of touching the local filesystem it
 * routes every call through the platform REST client into the connected
 * container. This is the same pattern pi's own gondolin and ssh examples use.
 *
 * Path handling: pi invokes tools with host-style paths (relative or absolute).
 * We forward the raw argument to the platform; the platform's executor resolves
 * it inside the container. We strip a leading `@` (some models prefix paths).
 */
import { basename, extname } from "node:path";
import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { PlatformClient } from "./client.ts";
import { REMOTE_WORKSPACE } from "./constants.ts";

/** Back-compat alias; prefer REMOTE_WORKSPACE from ./constants.ts. */
export { REMOTE_WORKSPACE as GUEST_WORKSPACE };

function stripAt(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createPlatformReadOps(client: PlatformClient, containerId: number): ReadOperations {
  return {
    readFile: (p) => client.toolRead(containerId, stripAt(p)),
    access: async (p) => {
      const exists = await client.toolAccess(containerId, stripAt(p));
      if (!exists) throw new Error(`No access: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const ext = extname(stripAt(p)).toLowerCase();
      return IMAGE_MIME[ext] ?? null;
    },
  };
}

export function createPlatformWriteOps(client: PlatformClient, containerId: number): WriteOperations {
  return {
    writeFile: (p, content) => client.toolWrite(containerId, stripAt(p), Buffer.from(content, "utf8")),
    mkdir: async (dir) => {
      // pi calls mkdir directly for some operations; the platform's writeFile
      // already creates parent dirs, but issue an explicit mkdir -p to be safe.
      await client.toolBash(containerId, `mkdir -p ${JSON.stringify(stripAt(dir))}`);
    },
  };
}

export function createPlatformEditOps(client: PlatformClient, containerId: number): EditOperations {
  const read = createPlatformReadOps(client, containerId);
  const write = createPlatformWriteOps(client, containerId);
  return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

export function createPlatformBashOps(client: PlatformClient, containerId: number): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        client
          .toolBash(containerId, command, { cwd, timeout })
          .then((result) => {
            if (result.stdout) onData?.(Buffer.from(result.stdout));
            if (result.stderr) onData?.(Buffer.from(result.stderr));
            resolve({ exitCode: result.timedOut ? null : result.exitCode });
          })
          .catch(reject);
        // Note: the platform bash is request/response at this layer (the SSE
        // stream endpoint exists for low-latency terminal use). Cancellation
        // via signal is honored at the fetch layer; on abort the promise above
        // rejects and pi treats it as a killed process.
        signal?.addEventListener("abort", () => {
          /* fetch abort handles rejection */
        });
      }),
  };
}

export function createPlatformLsOps(client: PlatformClient, containerId: number): LsOperations {
  return {
    exists: async (p) => client.toolAccess(containerId, stripAt(p)),
    stat: async (p) => {
      // pi's LsOperations.stat expects { isDirectory: () => boolean }.
      const s = await client.toolStat(containerId, stripAt(p));
      return { isDirectory: () => s.isDirectory };
    },
    readdir: async (dir) => {
      const entries = await client.toolLs(containerId, stripAt(dir) || ".");
      return entries.map((e) => e.name);
    },
  };
}

/** Grep/find results are produced platform-side (portable JS); just forward. */
export async function platformGrep(
  client: PlatformClient,
  containerId: number,
  params: {
    pattern: string;
    path?: string;
    glob?: string;
    literal?: boolean;
    ignoreCase?: boolean;
    context?: number;
    limit?: number;
  },
): Promise<string> {
  return client.toolGrep(containerId, params);
}

export async function platformFind(
  client: PlatformClient,
  containerId: number,
  params: { pattern: string; path?: string; limit?: number },
): Promise<string[]> {
  return client.toolFind(containerId, params);
}

// Re-export basename for callers that format paths.
export { basename };
