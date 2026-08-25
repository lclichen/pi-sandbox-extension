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
import { readdir, readFile, stat, mkdir, writeFile, readFile as readFileText } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SyncClient {
  toolWrite(containerId: number, path: string, content: Buffer): Promise<void>;
}

export interface SyncResult {
  /** Files actually uploaded this run. */
  files: number;
  /** Bytes actually uploaded this run. */
  bytes: number;
  /** Files skipped (oversized / unreadable). */
  skipped: number;
  /** Files unchanged since the last sync (incremental hit) — not re-uploaded. */
  unchanged: number;
  failures: string[];
}

export interface SyncOptions {
  ignoreDirs?: Set<string>;
  maxFileBytes?: number;
  onFile?: (rel: string, index: number, total: number) => void;
  /**
   * When true (default), skip files whose size+mtime match the last sync's
   * manifest. The manifest is keyed per containerId, so switching containers
   * forces a full re-sync automatically.
   */
  incremental?: boolean;
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

// ----- incremental sync manifest -----

interface SyncManifestEntry {
  size: number;
  mtime: number;
}
interface SyncManifest {
  version: 1;
  containerId: number;
  syncedAt: string;
  files: Record<string, SyncManifestEntry>;
}

/** Path to the per-project sync manifest (lives under .pi, which is ignored). */
function manifestPath(localRoot: string): string {
  return join(localRoot, ".pi", "sandbox-sync.json");
}

async function loadManifest(localRoot: string, containerId: number): Promise<Record<string, SyncManifestEntry>> {
  const path = manifestPath(localRoot);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(await readFileText(path, "utf8")) as SyncManifest;
    // Different container -> state is for another sandbox; start fresh.
    if (raw.containerId !== containerId) return {};
    return raw.files ?? {};
  } catch {
    return {};
  }
}

async function saveManifest(localRoot: string, containerId: number, files: Record<string, SyncManifestEntry>): Promise<void> {
  const path = manifestPath(localRoot);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const manifest: SyncManifest = { version: 1, containerId, syncedAt: new Date().toISOString(), files };
    await writeFile(path, JSON.stringify(manifest, null, 2));
  } catch {
    // Manifest is an optimization; failing to persist it just means a full sync next time.
  }
}

export interface LocalFile {
  /** POSIX-style path relative to the project root (e.g. "src/main.ts"). */
  rel: string;
  abs: string;
  size: number;
  /** Modification time in ms (for incremental sync). */
  mtimeMs: number;
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
          const st = await stat(abs);
          if (st.size > maxBytes) continue;
          out.push({ rel: relative(root, abs).split(sep).join("/"), abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // unreadable file — skip
        }
      }
    }
  };
  await walk(root);
  return out;
}

/**
 * Upload local project files into the container's /workspace. By default this is
 * incremental: a per-project manifest (.pi/sandbox-sync.json) records each
 * file's size+mtime, and unchanged files are skipped on re-runs. Switching to a
 * different container forces a full sync (the manifest is keyed by containerId).
 *
 * Note: deletion is intentionally NOT handled — this is a one-way local→container
 * sync. Files removed locally remain in the container until it is recreated.
 */
export async function syncWorkspaceToContainer(
  client: SyncClient,
  containerId: number,
  localRoot: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const incremental = opts.incremental ?? true;
  const files = await collectLocalFiles(localRoot, opts);
  const result: SyncResult = { files: 0, bytes: 0, skipped: 0, unchanged: 0, failures: [] };
  const prev = incremental ? await loadManifest(localRoot, containerId) : {};
  const next: Record<string, SyncManifestEntry> = {};

  for (const [index, file] of files.entries()) {
    const cached = prev[file.rel];
    // Incremental hit: same size AND mtime -> skip the upload.
    if (cached && cached.size === file.size && cached.mtime === file.mtimeMs) {
      result.unchanged += 1;
      next[file.rel] = cached;
      opts.onFile?.(file.rel, index + 1, files.length);
      continue;
    }

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
      next[file.rel] = { size: file.size, mtime: file.mtimeMs };
    } catch (err) {
      result.failures.push(`${file.rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
    opts.onFile?.(file.rel, index + 1, files.length);
  }

  if (incremental) await saveManifest(localRoot, containerId, next);
  return result;
}
