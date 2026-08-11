/**
 * Path translation between pi's host-style tool paths and container paths.
 *
 * pi resolves tool path arguments against the tool's cwd (node path.resolve)
 * BEFORE they reach our operations (read.ts: resolveReadPathAsync, write.ts:
 * resolveToCwd). We create the tools with cwd = /workspace, so:
 *
 *   - on win32, path.resolve("/workspace", "x") yields a DRIVE-absolute host
 *     path ("D:\workspace\x" — "/workspace" is drive-relative). Forwarded raw,
 *     the platform rejects it as escaping the sandbox root (or, for access,
 *     reports the file as missing → "No access: D:\workspace\...");
 *   - on POSIX, "x" resolves fine to "/workspace/x", but a "workspace/x"
 *     input (the convention the model and @ completion use) doubles the
 *     prefix to "/workspace/workspace/x".
 *
 * `toContainerPath` un-mangles both shapes back to container-absolute paths.
 * `containerPathToLocal` maps the same shapes onto the LOCAL project dir for
 * the offline (no-container) fallback.
 */
import { join } from "node:path";
import { REMOTE_WORKSPACE } from "./constants.ts";

function stripAt(p: string): string {
  return p.startsWith("@") ? p.slice(1) : p;
}

/** "/"-separated form used for cross-platform prefix compares. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip a win32 drive letter, producing a POSIX path ("D:\workspace\x" -> "/workspace/x"). */
function stripDrive(p: string): string {
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  return m ? "/" + norm(p.slice(2)).replace(/^\/+/, "") : p;
}

function ciEquals(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Convert whatever path pi hands to our operations into a container-absolute
 * path. Handles all shapes:
 *
 *   - win32 drive-absolute (pi's resolution of POSIX/relative input on win32)
 *   - POSIX absolute container paths ("/workspace/x", "/etc/hostname")
 *   - host-absolute paths resolved against the real session cwd (defensive;
 *     `localCwd` maps back to the container's /workspace)
 *   - bare relative paths ("x", "workspace/x") → /workspace/...
 */
export function toContainerPath(p: string, localCwd?: string): string {
  let s = stripAt(p);
  if (!s || s === ".") return REMOTE_WORKSPACE;

  // win32: pi's path.resolve turns even POSIX absolute input into a
  // drive-absolute host path ("/workspace/x" -> "D:\workspace\x").
  if (/^[A-Za-z]:[\\/]/.test(s)) s = stripDrive(s);
  s = norm(s);

  // Host-absolute path resolved against the session cwd: strip the cwd and
  // map onto /workspace. Drive-stripped paths can match here too (a local
  // dir literally named e.g. "D:\workspace" -> cwdPosix "/workspace").
  if (localCwd) {
    const cwdPosix = stripDrive(norm(localCwd)).replace(/\/+$/, "");
    if (cwdPosix && cwdPosix !== "/") {
      if (ciEquals(s, cwdPosix)) s = REMOTE_WORKSPACE;
      else if (s.startsWith(cwdPosix + "/")) s = REMOTE_WORKSPACE + s.slice(cwdPosix.length);
    }
  }

  // Leftover relative path: treat it as workspace-relative.
  if (!s.startsWith("/")) s = `${REMOTE_WORKSPACE}/${s}`;

  // pi resolved "workspace/x" against cwd /workspace, doubling the prefix
  // ("/workspace/workspace/x"); collapse it. A literal nested dir named
  // "workspace" under /workspace is the rare case we accept mis-routing for.
  if (s === `${REMOTE_WORKSPACE}/workspace`) return REMOTE_WORKSPACE;
  if (s.startsWith(`${REMOTE_WORKSPACE}/workspace/`)) {
    return REMOTE_WORKSPACE + s.slice(`${REMOTE_WORKSPACE}/workspace`.length);
  }
  return s;
}

/**
 * Map a container-style path onto the LOCAL filesystem for the offline
 * fallback (no container connected): the container's /workspace root maps to
 * the local project cwd itself. Paths pi already resolved to local absolute
 * paths (win32 drive, or POSIX under localCwd) are passed through untouched.
 */
export function containerPathToLocal(p: string, localCwd: string): string {
  const cleaned = stripAt(p);
  if (!cleaned || cleaned === ".") return localCwd;

  // Already local-absolute (pi resolved it against the host cwd): use as-is.
  if (/^[A-Za-z]:[\\/]/.test(cleaned)) return cleaned;
  const cwdPosix = stripDrive(norm(localCwd)).replace(/\/+$/, "");
  const pathPosix = norm(cleaned);
  if (cwdPosix && cwdPosix !== "/") {
    if (ciEquals(pathPosix, cwdPosix)) return localCwd;
    if (pathPosix.startsWith(cwdPosix + "/")) return cleaned;
  }

  // Container-style path: "/workspace/x", "workspace/x", "x" -> <cwd>/x.
  const rel = cleaned.replace(/^\/+/, "").replace(/^workspace(?=\/|$)/, "");
  if (!rel || rel === ".") return localCwd;
  return join(localCwd, ...rel.split("/"));
}
