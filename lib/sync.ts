/**
 * Workspace sync: upload the local project into the container's /workspace.
 *
 * The sandbox container lives on the platform server; the user's project
 * lives on their machine. `syncWorkspaceToContainer` walks the local project
 * directory (skipping heavy/derived dirs and oversized files) and uploads
 * every file via the platform's write relay into /workspace, so the agent
 * inside the container works on the same files the user sees locally.
 *
 * Paths are uploaded as `/workspace/<relative path>` (container-style), which
 * the platform resolves inside the sandbox. The client is injected as a small
 * structural interface so tests can stub it.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface SyncClient {
  toolWrite(containerId: number, path: string, content: Buffer): Promise<void>;
}

export interface SyncResult {
  files: number;
  bytes: number;
  skipped: number;
  failures: string[];
}

export interface SyncOptions {
  ignoreDirs?: Set<string>;
  maxFileBytes?: number;
  onFile?: (rel: string, index: number, total: number) => void;
}

/** Directories never uploaded (mirrors pi's local tool conventions). */
export const DEFAULT_SYNC_IGNORE = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".zcode",
  ".pi",
]);

/** Files larger than this are skipped (platform body limit is 16MB). */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface LocalFile {
  /** POSIX-style path relative to the project root (e.g. "src/main.ts"). */
  rel: string;
  abs: string;
  size: number;
}

/** Walk the local project, returning uploadable files (ignore/caps applied). */
export async function collectLocalFiles(
  root: string,
  opts: SyncOptions = {},
): Promise<LocalFile[]> {
  const ignore = opts.ignoreDirs ?? DEFAULT_SYNC_IGNORE;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const out: LocalFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        try {
          const size = (await stat(abs)).size;
          if (size > maxBytes) continue;
          out.push({ rel: relative(root, abs).split(sep).join("/"), abs, size });
        } catch {
          // unreadable file — skip
        }
      }
    }
  };
  await walk(root);
  return out;
}

/** Upload every local project file into the container's /workspace. */
export async function syncWorkspaceToContainer(
  client: SyncClient,
  containerId: number,
  localRoot: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const files = await collectLocalFiles(localRoot, opts);
  const result: SyncResult = { files: 0, bytes: 0, skipped: 0, failures: [] };
  for (const [index, file] of files.entries()) {
    let content: Buffer;
    try {
      content = await readFile(file.abs);
    } catch {
      result.skipped += 1;
      continue;
    }
    try {
      await client.toolWrite(containerId, `/workspace/${file.rel}`, content);
      result.files += 1;
      result.bytes += file.size;
    } catch (err) {
      result.failures.push(`${file.rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
    opts.onFile?.(file.rel, index + 1, files.length);
  }
  return result;
}
