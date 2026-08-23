import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { JobResult, PodcastJob, Result } from '../core/types.js';
import { err, jobResultErr, jobResultOk, ok } from '../core/types.js';
import {
  type VaultFilePath,
  type VaultRelativePath,
  parseVaultRelativePath,
  vaultPathBasename,
  withMarkdownExtension,
} from '../core/vault-path.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import {
  type VaultWorkspace,
  createVaultWorkspace,
  formatVaultPathError,
} from '../infra/vault-workspace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes (single text source)
const ARTIFACT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const FORMAT_LABELS: Record<number, string> = {
  0: 'Deep Dive',
  1: 'Brief',
  2: 'Critique',
  3: 'Debate',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type PodcastDeps = {
  readonly notebookLM: NotebookLMAdapter;
  readonly telegram: TelegramAdapter;
  readonly vaultBasePath: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // Dirent does not report symlinked directories as directories, so basename
    // fallback never crosses a symlink boundary while walking the vault.
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.isFile() && entry.name === filename) {
      return full;
    }
  }
  return null;
}

// ─── Note resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a vault-relative path to an absolute filesystem path.
 * Accepts paths with or without .md extension (Obsidian "Copy vault path" omits it).
 */
type ResolvedPodcastNote = {
  readonly filePath: VaultFilePath;
  readonly title: string;
};

async function resolveNotePath(
  workspace: VaultWorkspace,
  notePath: VaultRelativePath,
): Promise<Result<ResolvedPodcastNote, string>> {
  const withExtension = withMarkdownExtension(notePath);
  const exact = await workspace.resolveExistingFile(withExtension);
  if (exact.ok) {
    const title = vaultPathBasename(notePath).replace(/\.md$/i, '').replace(/-/g, ' ');
    return ok({ filePath: exact.value, title });
  }
  if (exact.error.kind !== 'not-found') return err(formatVaultPathError(exact.error));

  // Preserve the existing basename fallback, but walk only real directories.
  const filename = vaultPathBasename(withExtension);
  try {
    const match = await findFileRecursive(workspace.root, filename);
    if (match === null) return err(`note not found — "${notePath}"`);
    const matchedRelative = parseVaultRelativePath(relative(workspace.root, match));
    if (!matchedRelative.ok) return err(matchedRelative.error);
    const resolvedMatch = await workspace.resolveExistingFile(matchedRelative.value);
    if (!resolvedMatch.ok) return err(formatVaultPathError(resolvedMatch.error));
    const title = filename.replace(/\.md$/i, '').replace(/-/g, ' ');
    return ok({ filePath: resolvedMatch.value, title });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`vault search failed: ${message}`);
  }
}

// ─── Vault link-back ─────────────────────────────────────────────────────────

async function appendPodcastLinkToResolvedFile(
  filePath: VaultFilePath,
  formatLabel: string,
  shareUrl: string,
): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- [${formatLabel} — ${date}](${shareUrl})`;

  if (content.includes('## Podcasts')) {
    // Section exists — append entry at end (Podcasts is always last section)
    const suffix = content.endsWith('\n') ? '' : '\n';
    await writeFile(filePath, `${content}${suffix}${entry}\n`, 'utf-8');
  } else {
    // Add new section at end of file
    const suffix = content.endsWith('\n') ? '\n' : '\n\n';
    await writeFile(filePath, `${content}${suffix}## Podcasts\n\n${entry}\n`, 'utf-8');
  }
}

/** Root-confined public link-back operation used by integration tests and callers. */
export async function appendPodcastLink(
  vaultBasePath: string,
  notePath: string,
  formatLabel: string,
  shareUrl: string,
): Promise<void> {
  const parsedPath = parseVaultRelativePath(notePath);
  if (!parsedPath.ok) throw new Error(parsedPath.error);
  const workspace = await createVaultWorkspace(vaultBasePath);
  if (!workspace.ok) throw new Error(formatVaultPathError(workspace.error));
  const filePath = await workspace.value.resolveExistingFile(
    withMarkdownExtension(parsedPath.value),
  );
  if (!filePath.ok) throw new Error(formatVaultPathError(filePath.error));
  await appendPodcastLinkToResolvedFile(filePath.value, formatLabel, shareUrl);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handlePodcastJob(job: PodcastJob, deps: PodcastDeps): Promise<JobResult> {
  const { notebookLM, telegram } = deps;
  const formatLabel = FORMAT_LABELS[job.audioFormat] ?? 'Deep Dive';

  // 1. Resolve note through the configured, canonical vault root.
  const workspace = await createVaultWorkspace(deps.vaultBasePath);
  if (!workspace.ok) {
    const msg = `Podcast failed: ${formatVaultPathError(workspace.error)}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  const note = await resolveNotePath(workspace.value, job.notePath);
  if (!note.ok) {
    const msg = `Podcast failed: ${note.error}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  const content = await readFile(note.value.filePath, 'utf-8');
  if (content.trim().length === 0) {
    const msg = `Podcast failed: note is empty — "${job.notePath}"`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 2. Send progress
  await telegram
    .sendMessage(job.chatId, `Generating ${formatLabel} podcast for: ${note.value.title}...`)
    .catch(console.error);

  // 3. Create notebook
  const nbResult = await notebookLM.createNotebook(`Podcast: ${note.value.title}`);
  if (!nbResult.ok) {
    const msg = `Podcast failed: could not create notebook — ${nbResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  const notebookId = nbResult.value;

  // 4. Add text source
  const addResult = await notebookLM.addSourceText(notebookId, note.value.title, content);
  if (!addResult.ok) {
    const msg = `Podcast failed: could not add note as source — ${addResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 5. Wait for processing
  const procResult = await notebookLM.waitForProcessing(notebookId, SOURCE_PROCESSING_TIMEOUT_MS);
  if (!procResult.ok) {
    const msg = `Podcast failed: source processing timed out — ${procResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 6. Create audio overview
  const audioResult = await notebookLM.createAudioOverview(notebookId, {
    instructions: `Create a ${formatLabel.toLowerCase()} audio overview about: ${note.value.title}`,
    customization: { format: job.audioFormat, length: job.audioLength },
  });
  if (!audioResult.ok) {
    const msg = `Podcast failed: audio creation failed — ${audioResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  const artifactId = audioResult.value;

  // 7. Wait for artifact
  const artifactResult = await notebookLM.waitForArtifact(
    artifactId,
    notebookId,
    ARTIFACT_TIMEOUT_MS,
  );
  if (!artifactResult.ok) {
    const msg = `Podcast failed: artifact generation timed out — ${artifactResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  if (artifactResult.value === 'failed') {
    const msg = `Podcast failed: NotebookLM could not generate audio for "${note.value.title}"`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 8. Share notebook
  const shareResult = await notebookLM.shareNotebook(notebookId);
  const shareUrl = shareResult.ok
    ? shareResult.value
    : `https://notebooklm.google.com/notebook/${notebookId}`;

  // 9. Link podcast back to source note. The audio already exists and is
  // shared, so a link-back failure must NOT fail the job — but it also must not
  // be swallowed: previously the rejection was logged and the user was told
  // "ready" with no hint the note was never updated. Capture the outcome and
  // surface it in the notification so a silent vault-write blip is visible.
  const linkBack = await appendPodcastLinkToResolvedFile(
    note.value.filePath,
    formatLabel,
    shareUrl,
  ).then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  );
  if (!linkBack.ok) {
    console.error(`[podcast] link-back to ${note.value.filePath} failed:`, linkBack.error);
  }

  // 10. Notify
  const linkBackNote = linkBack.ok
    ? ''
    : "\n\n⚠️ Heads up: I couldn't add the podcast link back into the source note.";
  const successMsg = `Podcast ready: ${note.value.title}\nFormat: ${formatLabel}\n\n${shareUrl}${linkBackNote}`;
  await telegram.sendMessage(job.chatId, successMsg);

  return jobResultOk(successMsg);
}
