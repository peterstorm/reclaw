import { chmod, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Durable default spool for attachments accepted before BullMQ processing. */
export const DEFAULT_ATTACHMENT_DIR = join(homedir(), '.local', 'state', 'reclaw', 'images');

/** Atomically write one owner-only file into the (owner-only) attachment spool. */
export async function writeSpooledFile(
  attachmentDir: string,
  filePath: string,
  data: Uint8Array | string,
): Promise<void> {
  await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
  await chmod(attachmentDir, 0o700);
  const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

/** Idempotently remove one file only when its canonical target is in the attachment spool. */
export async function removeSpooledFile(
  path: string,
  attachmentDir = DEFAULT_ATTACHMENT_DIR,
): Promise<void> {
  try {
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(attachmentDir),
      realpath(resolve(path)),
    ]);
    const fromRoot = relative(canonicalRoot, canonicalFile);
    if (
      fromRoot.length === 0 ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`Refusing to remove file outside Telegram attachment spool: ${path}`);
    }
    await unlink(canonicalFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
