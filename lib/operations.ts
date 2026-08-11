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
import { PlatformClient, PlatformError } from "./client.ts";
import { REMOTE_WORKSPACE } from "./constants.ts";
import { toContainerPath } from "./paths.ts";

/** Back-compat alias; prefer REMOTE_WORKSPACE from ./constants.ts. */
export { REMOTE_WORKSPACE as GUEST_WORKSPACE };

/** Path handler for a platform ops factory: normalize pi's path shapes to
 *  container-absolute, then strip a stray @ prefix. */
type PathMapper = (p: string) => string;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Normalize pi's tool path arguments to container-absolute paths before
 * forwarding (see lib/paths.ts for why: on win32 pi's path.resolve mangles
 * them into drive-absolute host paths the platform must reject). `localCwd`
 * is the host project dir (maps to /workspace), used defensively when pi
 * resolves against the real session cwd.
 */
export function pathMapper(localCwd: string | undefined): PathMapper {
  return (p: string) => toContainerPath(p, localCwd);
}

export function createPlatformReadOps(
  client: PlatformClient,
  containerId: number,
  localCwd?: string,
): ReadOperations {
  const map = pathMapper(localCwd);
  return {
    readFile: (p) => client.toolRead(containerId, map(p)),
    access: async (p) => {
      const exists = await client.toolAccess(containerId, map(p));
      if (!exists) throw new Error(`No access: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const ext = extname(map(p)).toLowerCase();
      return IMAGE_MIME[ext] ?? null;
    },
  };
}

export function createPlatformWriteOps(
  client: PlatformClient,
  containerId: number,
  localCwd?: string,
): WriteOperations {
  const map = pathMapper(localCwd);
  return {
    writeFile: (p, content) => client.toolWrite(containerId, map(p), Buffer.from(content, "utf8")),
    mkdir: async (dir) => {
      // pi calls mkdir directly for some operations; the platform's writeFile
      // already creates parent dirs, but issue an explicit mkdir -p to be safe.
      await client.toolBash(containerId, `mkdir -p ${JSON.stringify(map(dir))}`);
    },
  };
}

export function createPlatformEditOps(
  client: PlatformClient,
  containerId: number,
  localCwd?: string,
): EditOperations {
  const read = createPlatformReadOps(client, containerId, localCwd);
  const write = createPlatformWriteOps(client, containerId, localCwd);
  return { readFile: read.readFile, writeFile: write.writeFile, access: read.access };
}

export function createPlatformBashOps(client: PlatformClient, containerId: number): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        // Live output: stream via SSE so chunks arrive in real time. If the
        // platform predates the stream endpoint (404/405), fall back to the
        // request/response bash and replay the collected output.
        client
          .toolBashStream(containerId, command, { cwd, timeout, signal, onData })
          .then((result) => resolve({ exitCode: result.exitCode }))
          .catch((err) => {
            if (err instanceof PlatformError && (err.status === 404 || err.status === 405)) {
              client
                .toolBash(containerId, command, { cwd, timeout })
                .then((result) => {
                  if (result.stdout) onData?.(Buffer.from(result.stdout));
                  if (result.stderr) onData?.(Buffer.from(result.stderr));
                  resolve({ exitCode: result.timedOut ? null : result.exitCode });
                })
                .catch(reject);
              return;
            }
            reject(err);
          });
      }),
  };
}

/**
 * Wrap bash operations so `exec` always runs in the container workspace root,
 * ignoring the cwd pi passes in. pi's `user_bash` (`!`/`!!` commands) hands
 * the LOCAL session cwd (a host path) to the operations — the platform would
 * reject it as escaping the sandbox. The user's project lives at the
 * container's /workspace, so commands run there.
 */
export function withContainerCwd(ops: BashOperations, remoteCwd = REMOTE_WORKSPACE): BashOperations {
  return {
    ...ops,
    exec: (command, _cwd, options) => ops.exec(command, remoteCwd, options),
  };
}

export function createPlatformLsOps(
  client: PlatformClient,
  containerId: number,
  localCwd?: string,
): LsOperations {
  const map = pathMapper(localCwd);
  return {
    exists: async (p) => client.toolAccess(containerId, map(p)),
    stat: async (p) => {
      // pi's LsOperations.stat expects { isDirectory: () => boolean }.
      const s = await client.toolStat(containerId, map(p));
      return { isDirectory: () => s.isDirectory };
    },
    readdir: async (dir) => {
      const entries = await client.toolLs(containerId, map(dir || "."));
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
  localCwd?: string,
): Promise<string> {
  return client.toolGrep(containerId, {
    ...params,
    path: params.path ? toContainerPath(params.path, localCwd) : undefined,
  });
}

export async function platformFind(
  client: PlatformClient,
  containerId: number,
  params: { pattern: string; path?: string; limit?: number },
  localCwd?: string,
): Promise<string[]> {
  return client.toolFind(containerId, {
    ...params,
    path: params.path ? toContainerPath(params.path, localCwd) : undefined,
  });
}

// Re-export basename for callers that format paths.
export { basename };
