import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ObsidianNote = {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
};

export type ObsidianAdapter = {
  readonly readNote: (relativePath: string) => Promise<ObsidianNote | null>;
  readonly writeNote: (
    relativePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
  ) => Promise<void>;
  readonly listNotes: (folder?: string) => Promise<readonly string[]>;
  readonly searchNotes: (query: string) => Promise<readonly ObsidianNote[]>;
};

// ─── Path helpers (pure) ──────────────────────────────────────────────────────

/**
 * Resolve a relative path against vaultPath and verify it does not escape
 * the vault root (path traversal protection, NFR-012).
 * Returns the resolved absolute path or null if traversal detected.
 */
function resolveSafePath(vaultPath: string, relativePath: string): string | null {
  const resolved = path.resolve(vaultPath, relativePath);
  // Ensure the resolved path is within vaultPath
  const vaultNormalized = path.resolve(vaultPath);
  if (!resolved.startsWith(vaultNormalized + path.sep) && resolved !== vaultNormalized) {
    return null;
  }
  return resolved;
}

// ─── Filesystem helpers (imperative shell) ────────────────────────────────────

/**
 * Recursively collect all .md file paths under `dir`.
 * Returns paths relative to `vaultPath`.
 */
async function collectMarkdownFiles(dir: string, vaultPath: string): Promise<string[]> {
  let results: string[] = [];
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(fullPath, vaultPath);
      results = results.concat(nested);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(path.relative(vaultPath, fullPath));
    }
  }
  return results;
}

// ─── Parsing helpers (pure) ───────────────────────────────────────────────────

function parseNote(relativePath: string, raw: string): ObsidianNote {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new Error(`Failed to parse frontmatter in "${relativePath}": ${String(err)}`);
  }
  return {
    path: relativePath,
    frontmatter: parsed.data as Record<string, unknown>,
    content: parsed.content,
  };
}

function stringifyNote(frontmatter: Record<string, unknown>, content: string): string {
  return matter.stringify(content, frontmatter);
}

/**
 * Check if query string matches the note (case-insensitive).
 * Searches content and all frontmatter string and numeric values.
 */
function noteMatchesQuery(note: ObsidianNote, lowerQuery: string): boolean {
  if (note.content.toLowerCase().includes(lowerQuery)) return true;
  for (const value of Object.values(note.frontmatter)) {
    if (typeof value === 'string' && value.toLowerCase().includes(lowerQuery)) return true;
    if (typeof value === 'number' && String(value).toLowerCase().includes(lowerQuery)) return true;
  }
  return false;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an Obsidian vault adapter.
 *
 * - FR-008: Provides persistent workspace directory accessible to subprocesses
 * - FR-030: Persists data across process/container restarts via filesystem
 * - NFR-012: Path traversal protection prevents writes outside vaultPath
 */
export function createObsidianAdapter(vaultPath: string): ObsidianAdapter {
  const vault = path.resolve(vaultPath);

  async function readNote(relativePath: string): Promise<ObsidianNote | null> {
    const safePath = resolveSafePath(vault, relativePath);
    if (safePath === null) return null;
    try {
      const raw = await fs.readFile(safePath, 'utf-8');
      return parseNote(relativePath, raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeNote(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
  ): Promise<void> {
    const safePath = resolveSafePath(vault, relativePath);
    if (safePath === null) {
      throw new Error(`Path traversal detected: "${relativePath}" escapes vault root`);
    }
    const dir = path.dirname(safePath);
    await fs.mkdir(dir, { recursive: true });
    const serialized = stringifyNote(frontmatter, content);
    await fs.writeFile(safePath, serialized, 'utf-8');
  }

  async function listNotes(folder?: string): Promise<readonly string[]> {
    const searchRoot = folder ? resolveSafePath(vault, folder) : vault;
    if (searchRoot === null) return [];
    try {
      await fs.access(searchRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return collectMarkdownFiles(searchRoot, vault);
  }

  async function searchNotes(query: string): Promise<readonly ObsidianNote[]> {
    const lowerQuery = query.toLowerCase();
    const allPaths = await listNotes();
    const results: ObsidianNote[] = [];
    for (const notePath of allPaths) {
      const note = await readNote(notePath);
      if (note !== null && noteMatchesQuery(note, lowerQuery)) {
        results.push(note);
      }
    }
    return results;
  }

  return { readNote, writeNote, listNotes, searchNotes };
}
