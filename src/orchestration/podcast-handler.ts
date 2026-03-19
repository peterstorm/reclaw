import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { PodcastJob, JobResult } from '../core/types.js';
import { jobResultOk, jobResultErr } from '../core/types.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { TelegramAdapter } from '../infra/telegram.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const VAULT_ROOT = '/home/peterstorm/dev/notes/remotevault';
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
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name === filename) {
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
async function resolveNotePath(notePath: string): Promise<{ filePath: string; title: string } | null> {
  // Normalize: strip leading slash if present
  const normalized = notePath.replace(/^\//, '');

  // Try exact path first (with .md appended if needed)
  const withExtension = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  const absolute = resolve(VAULT_ROOT, withExtension);

  try {
    await readFile(absolute, 'utf-8');
    // Title: last segment of path, without extension
    const title = normalized.split('/').pop()!.replace(/\.md$/, '').replace(/-/g, ' ');
    return { filePath: absolute, title };
  } catch {
    // Not found at exact path — try recursive search by filename
    const filename = normalized.split('/').pop()!.replace(/\.md$/, '') + '.md';
    const match = await findFileRecursive(VAULT_ROOT, filename);
    if (match) {
      const title = filename.replace(/\.md$/, '').replace(/-/g, ' ');
      return { filePath: match, title };
    }
    return null;
  }
}

// ─── Vault link-back ─────────────────────────────────────────────────────────

export async function appendPodcastLink(
  filePath: string,
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

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handlePodcastJob(
  job: PodcastJob,
  deps: PodcastDeps,
): Promise<JobResult> {
  const { notebookLM, telegram } = deps;
  const formatLabel = FORMAT_LABELS[job.audioFormat] ?? 'Deep Dive';

  // 1. Resolve note
  const note = await resolveNotePath(job.notePath);
  if (!note) {
    const msg = `Podcast failed: note not found — "${job.notePath}"`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  const content = await readFile(note.filePath, 'utf-8');
  if (content.trim().length === 0) {
    const msg = `Podcast failed: note is empty — "${job.notePath}"`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 2. Send progress
  await telegram.sendMessage(job.chatId, `Generating ${formatLabel} podcast for: ${note.title}...`).catch(console.error);

  // 3. Create notebook
  const nbResult = await notebookLM.createNotebook(`Podcast: ${note.title}`);
  if (!nbResult.ok) {
    const msg = `Podcast failed: could not create notebook — ${nbResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  const notebookId = nbResult.value;

  // 4. Add text source
  const addResult = await notebookLM.addSourceText(notebookId, note.title, content);
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
    instructions: `Create a ${formatLabel.toLowerCase()} audio overview about: ${note.title}`,
    customization: { format: job.audioFormat, length: job.audioLength },
  });
  if (!audioResult.ok) {
    const msg = `Podcast failed: audio creation failed — ${audioResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  const artifactId = audioResult.value;

  // 7. Wait for artifact
  const artifactResult = await notebookLM.waitForArtifact(artifactId, notebookId, ARTIFACT_TIMEOUT_MS);
  if (!artifactResult.ok) {
    const msg = `Podcast failed: artifact generation timed out — ${artifactResult.error.message}`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }
  if (artifactResult.value === 'failed') {
    const msg = `Podcast failed: NotebookLM could not generate audio for "${note.title}"`;
    await telegram.sendMessage(job.chatId, msg).catch(console.error);
    return jobResultErr(msg);
  }

  // 8. Share notebook
  const shareResult = await notebookLM.shareNotebook(notebookId);
  const shareUrl = shareResult.ok ? shareResult.value : `https://notebooklm.google.com/notebook/${notebookId}`;

  // 9. Link podcast back to source note
  await appendPodcastLink(note.filePath, formatLabel, shareUrl).catch(console.error);

  // 10. Notify
  const successMsg = `Podcast ready: ${note.title}\nFormat: ${formatLabel}\n\n${shareUrl}`;
  await telegram.sendMessage(job.chatId, successMsg).catch(console.error);

  return jobResultOk(successMsg);
}
