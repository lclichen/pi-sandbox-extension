/**
 * Container-aware `@` file autocomplete for pi.
 *
 * pi's built-in autocomplete (packages/tui/src/autocomplete.ts) resolves `@`
 * mentions with `fd` against the LOCAL filesystem. When a sandbox container is
 * connected, this module wraps the built-in provider so `@` completes files
 * inside the container instead:
 *
 *   - prefix not starting with "/"  -> workspace-relative (inserts e.g.
 *     "src/util.ts"), matching the path convention pi's read/write tools use
 *   - prefix starting with "/"      -> container-absolute (inserts e.g.
 *     "/workspace/src/util.ts")
 *   - `@"quoted prefix` form is honored; values are quoted when the path
 *     contains spaces, exactly like the built-in
 *
 * When no container is connected the wrapper delegates to the current
 * (built-in, local-fd) provider.
 *
 * The suggestion logic (`suggestContainerFiles`) is pure and takes a
 * `listDir` callback so it can be unit-tested without a live container.
 */
import type { PlatformClient } from "./client.ts";

// ---------------------------------------------------------------------------
// Structural types mirroring @earendil-works/pi-tui (the extension is
// zero-dependency; type-only imports are erased at runtime, but keeping local
// structural types makes the intent explicit).
// ---------------------------------------------------------------------------

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  /** What the completion replaces (e.g. "@src/ut" — includes the @). */
  prefix: string;
}

export interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

// ---------------------------------------------------------------------------
// Prefix parsing — mirrors packages/tui/src/autocomplete.ts helpers so the
// wrapper triggers on exactly the same input shapes as the built-in.
// ---------------------------------------------------------------------------

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/** Extract the @-mention prefix at the cursor (includes the @), or null.
 *  Mirrors pi-tui's extractAtPrefix: only `@...` or `@"...` tokens count —
 *  plain unclosed quotes must NOT be treated as mentions. */
export function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix?.startsWith('@"')) return quotedPrefix;
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

/** Unclosed-quote prefix, mirroring pi-tui's extractQuotedPrefix. */
function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) return null;
  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) return null;
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) return null;
  return text.slice(quoteStart);
}

/** Build the inserted value (mirrors buildCompletionValue in pi-tui). */
export function buildCompletionValue(
  path: string,
  options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
  const needsQuotes = options.isQuotedPrefix || path.includes(" ");
  const prefix = options.isAtPrefix ? "@" : "";
  if (!needsQuotes) return `${prefix}${path}`;
  return `${prefix}"${path}"`;
}

// ---------------------------------------------------------------------------
// Suggestion logic
// ---------------------------------------------------------------------------

export interface ContainerFileEntry {
  name: string;
  isDirectory: boolean;
}

const EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const MAX_SUGGESTIONS = 50;

/**
 * Resolve @-completion items against the container filesystem.
 *
 * `listDir(dir)` returns one directory level (container-side, posix paths);
 * it is injected so tests can stub it. `rawPrefix` is the text after the `@`
 * (no @, no quotes). Returns items whose `value`/`label` is the completed
 * path; directories carry a trailing "/".
 */
export async function suggestContainerFiles(
  listDir: (dir: string) => Promise<ContainerFileEntry[]>,
  rawPrefix: string,
  opts: { workspaceRoot?: string; maxResults?: number } = {},
): Promise<AutocompleteItem[]> {
  const maxResults = opts.maxResults ?? MAX_SUGGESTIONS;
  const workspaceRoot = opts.workspaceRoot ?? "/workspace";
  const absolute = rawPrefix.startsWith("/");
  let cleaned = rawPrefix.replace(/^\/+/, "");
  // In workspace-relative mode a typed "workspace/..." prefix refers to the
  // workspace root itself (the same convention read/write use); strip it so
  // the listing starts at /workspace, not /workspace/workspace.
  if (!absolute && (cleaned === "workspace" || cleaned.startsWith("workspace/"))) {
    cleaned = cleaned.slice("workspace".length);
  }
  const slashIdx = cleaned.lastIndexOf("/");
  const dirPart = slashIdx === -1 ? "" : cleaned.slice(0, slashIdx);
  const basePart = slashIdx === -1 ? cleaned : cleaned.slice(slashIdx + 1);

  // The directory whose children may match the typed prefix.
  let containerDir: string;
  if (absolute) containerDir = dirPart ? `/${dirPart}` : "/";
  else containerDir = dirPart ? `${workspaceRoot}/${dirPart}` : workspaceRoot;

  let entries: ContainerFileEntry[];
  try {
    entries = await listDir(containerDir);
  } catch {
    return [];
  }

  const needle = basePart.toLowerCase();
  const results: AutocompleteItem[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (needle && !entry.name.toLowerCase().includes(needle)) continue;
    const suffix = entry.isDirectory ? "/" : "";
    const path = absolute
      ? dirPart
        ? `/${dirPart}/${entry.name}`
        : `/${entry.name}`
      : dirPart
        ? `${dirPart}/${entry.name}`
        : entry.name;
    results.push({ value: `${path}${suffix}`, label: `${path}${suffix}` });
    if (results.length >= maxResults) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Provider wrapper
// ---------------------------------------------------------------------------

/** Active sandbox session needed for completion (client + container id). */
export interface CompletionSession {
  client: PlatformClient;
  containerId: number;
}

/**
 * Wrap the current autocomplete provider: when a container session is active,
 * `@` completes container files (via the platform's ls relay); otherwise it
 * delegates to the built-in provider (local fd).
 */
export function createContainerAutocompleteProvider(
  current: AutocompleteProvider,
  getSession: () => CompletionSession | undefined,
): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const session = getSession();
      if (!session) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const currentLine = lines[cursorLine] ?? "";
      const atPrefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (!atPrefix) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const isQuoted = atPrefix.startsWith('@"');
      const rawPrefix = isQuoted ? atPrefix.slice(2) : atPrefix.slice(1);
      const items = await suggestContainerFiles(
        (dir) =>
          session.client.toolLs(session.containerId, dir).then((entries) =>
            entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory })),
          ),
        rawPrefix,
      );
      if (items.length === 0) return null;
      if (options.signal.aborted) return null;

      return {
        items: items.map((it) => ({
          value: buildCompletionValue(it.label, {
            isDirectory: it.label.endsWith("/"),
            isAtPrefix: true,
            isQuotedPrefix: isQuoted,
          }),
          label: it.label,
        })),
        prefix: atPrefix,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // OUR container-file completions carry an @-prefixed value (produced by
      // buildCompletionValue). EVERYTHING else — slash commands (whose items
      // carry NO leading "/", added by the built-in's isSlashCommand branch),
      // command arguments, local paths — is delegated to the wrapped provider;
      // mishandling those breaks e.g. "/sandbox-login" submitting as plain
      // "sandbox-login".
      if (item.value.startsWith("@")) {
        return this.applyAtCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    /** @-attachment insertion, mirroring the built-in branch. */
    applyAtCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ): { lines: string[]; cursorLine: number; cursorCol: number } {
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
      const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
      const hasTrailingQuoteInItem = item.value.endsWith('"');
      const adjustedAfterCursor =
        isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

      const isDirectory = item.label.endsWith("/");
      const suffix = isDirectory ? "" : " "; // no space after dirs: keep completing
      const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
      const newLines = [...lines];
      newLines[cursorLine] = newLine;

      const hasTrailingQuote = item.value.endsWith('"');
      const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + cursorOffset + suffix.length,
      };
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (!getSession()) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      }
      // Same rule as the built-in: never trigger for a leading slash command.
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
        return false;
      }
      return true;
    },
  };
}
