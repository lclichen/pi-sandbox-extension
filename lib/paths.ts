/**
 * Path translation for the offline (no-container) fallback.
 *
 * When no container is connected, the built-in tools execute on the LOCAL
 * host. Tool params reference container-style paths (e.g. "/workspace",
 * "/workspace/src/main.ts"), which would resolve to nonsense host paths
 * ("D:\workspace") on win32. Translate them like the platform does: the
 * container root maps to the local project cwd.
 */
import { join } from "node:path";

/** Map a container-style path onto the local filesystem.
 *  The container's WORKSPACE ROOT ("/workspace") maps to the local project
 *  cwd itself; other container-root paths ("/x", "x") map to <cwd>/x. */
export function containerPathToLocal(p: string, localCwd: string): string {
  const cleaned = p.startsWith("@") ? p.slice(1) : p;
  if (!cleaned || cleaned === ".") return localCwd;
  const rel = cleaned
    .replace(/^\/+/, "")
    .replace(/^workspace(?=\/|$)/, "");
  if (!rel || rel === ".") return localCwd;
  return join(localCwd, ...rel.split("/"));
}
