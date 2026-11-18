import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramFileSource } from './telegram-download.js';
import {
  type IncomingHandler,
  type IngressDeps,
  type TextUpdate,
  createIngressGate,
  receiveDocument,
  receivePhoto,
  receiveText,
} from './telegram-ingress.js';

// The per-update handlers are plain functions of (deps, ctx), so these tests
// drive them with object literals: no grammY Bot, no module mocks.

const AUTHORIZED = 123456;
const CHAT = 789;

function fakeFiles(filePath = 'photos/file_1.png'): TelegramFileSource & {
  readonly getFile: ReturnType<typeof vi.fn>;
} {
  const getFile = vi.fn().mockResolvedValue({ file_path: filePath });
  return { api: { getFile } as unknown as TelegramFileSource['api'], token: 'test-token', getFile };
}

function makeIngress(attachmentDir = '/tmp/reclaw-ingress-unused') {
  const { updates, lifecycle } = createIngressGate();
  const sendMessage = vi.fn().mockResolvedValue(1);
  const files = fakeFiles();
  const deps: IngressDeps = {
    gate: updates,
    files,
    authorizedUserIds: new Set([AUTHORIZED]),
    attachmentDir,
    uploadDir: undefined,
    pdfTextExtractor: undefined,
    sendMessage,
  };
  return { deps, lifecycle, sendMessage, files };
}

function textUpdate(userId: number | undefined, updateId = 1001): TextUpdate {
  return {
    from: userId === undefined ? undefined : { id: userId },
    chat: { id: CHAT },
    update: { update_id: updateId },
    message: { text: 'hello' },
  };
}

/** A handler whose settlement the test controls. */
function pendingHandler() {
  let release: () => void = () => {};
  const handler = vi.fn<IncomingHandler>(
    () =>
      new Promise((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  return { handler, release: () => release() };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Gate lifecycle ───────────────────────────────────────────────────────────

describe('createIngressGate', () => {
  it('drains only once every tracked update has settled', async () => {
    const { updates, lifecycle } = createIngressGate();
    let release: () => void = () => {};
    const tracked = updates.track(
      CHAT,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    let drained = false;
    const draining = lifecycle.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(lifecycle.isStopping()).toBe(true);
    expect(drained).toBe(false);

    release();
    await Promise.all([tracked, draining]);
    expect(drained).toBe(true);
    expect(lifecycle.hasFailed()).toBe(false);
  });

  it('fails the ingress when a tracked update throws, and propagates the error', async () => {
    const { updates, lifecycle } = createIngressGate();

    await expect(
      updates.track(CHAT, async () => {
        throw new Error('enqueue failed');
      }),
    ).rejects.toThrow('enqueue failed');

    expect(lifecycle.hasFailed()).toBe(true);
    expect(lifecycle.isStopping()).toBe(false);
  });

  it('keeps a failure through a later stop request', async () => {
    const { lifecycle } = createIngressGate();
    lifecycle.markFailed();

    await lifecycle.drain();

    expect(lifecycle.hasFailed()).toBe(true);
    expect(lifecycle.isStopping()).toBe(true);
  });

  it('remembers a stop request through a later failure', async () => {
    const { lifecycle } = createIngressGate();
    await lifecycle.drain();

    lifecycle.markFailed();

    expect(lifecycle.hasFailed()).toBe(true);
    expect(lifecycle.isStopping()).toBe(true);
  });

  it('refuses to admit an update once stopping, failing the ingress', async () => {
    const { updates, lifecycle } = createIngressGate();
    expect(() => updates.admit()).not.toThrow();

    await lifecycle.drain();

    expect(() => updates.admit()).toThrow('Telegram ingress is stopping');
    expect(lifecycle.hasFailed()).toBe(true);
  });
});

// ─── Text updates ─────────────────────────────────────────────────────────────

describe('receiveText', () => {
  it('awaits the handler for an authorized update', async () => {
    const { deps, lifecycle } = makeIngress();
    const { handler, release } = pendingHandler();
    lifecycle.setHandler(handler);

    let settled = false;
    const receiving = receiveText(deps, textUpdate(AUTHORIZED)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({
      updateId: 1001,
      userId: AUTHORIZED,
      chatId: CHAT,
      text: 'hello',
    });
    expect(settled).toBe(false);

    release();
    await receiving;
    expect(settled).toBe(true);
  });

  it.each([
    { label: 'an unauthorized user', userId: 999999 },
    { label: 'an update without a sender', userId: undefined },
  ])('silently discards $label', async ({ userId }) => {
    const { deps, lifecycle, sendMessage } = makeIngress();
    const handler = vi.fn<IncomingHandler>();
    lifecycle.setHandler(handler);

    await expect(receiveText(deps, textUpdate(userId))).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(lifecycle.hasFailed()).toBe(false);
  });

  it('discards an authorized update whose update ID is malformed, without failing', async () => {
    const { deps, lifecycle } = makeIngress();
    const handler = vi.fn<IncomingHandler>();
    lifecycle.setHandler(handler);

    await receiveText(deps, textUpdate(AUTHORIZED, -1));

    expect(handler).not.toHaveBeenCalled();
    expect(lifecycle.hasFailed()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`Discarding malformed update ID for chatId=${CHAT}`),
    );
  });

  it('refuses an authorized update once stopping, leaving it unacknowledged', async () => {
    const { deps, lifecycle } = makeIngress();
    const handler = vi.fn<IncomingHandler>();
    lifecycle.setHandler(handler);
    await lifecycle.drain();

    await expect(receiveText(deps, textUpdate(AUTHORIZED))).rejects.toThrow(
      'Telegram ingress is stopping',
    );

    expect(handler).not.toHaveBeenCalled();
    expect(lifecycle.hasFailed()).toBe(true);
  });

  it('discards an unauthorized update while stopping without failing the ingress', async () => {
    const { deps, lifecycle } = makeIngress();
    lifecycle.setHandler(vi.fn<IncomingHandler>());
    await lifecycle.drain();

    await expect(receiveText(deps, textUpdate(999999))).resolves.toBeUndefined();

    expect(lifecycle.hasFailed()).toBe(false);
  });

  it('fails closed when no handler is registered', async () => {
    const { deps } = makeIngress();

    await expect(receiveText(deps, textUpdate(AUTHORIZED))).rejects.toThrow('not registered');
  });
});

// ─── Documents ────────────────────────────────────────────────────────────────

describe('receiveDocument', () => {
  it('answers conflicting filename and MIME claims without downloading', async () => {
    const { deps, lifecycle, sendMessage, files } = makeIngress();
    const handler = vi.fn<IncomingHandler>();
    lifecycle.setHandler(handler);

    await receiveDocument(deps, {
      from: { id: AUTHORIZED },
      chat: { id: CHAT },
      update: { update_id: 1003 },
      message: {
        document: { file_id: 'doc', file_name: 'notes.md', mime_type: 'application/pdf' },
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(CHAT, expect.stringContaining('disagree'));
    expect(files.getFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Photos ───────────────────────────────────────────────────────────────────

describe('receivePhoto', () => {
  let attachmentDir: string;

  beforeEach(async () => {
    attachmentDir = await mkdtemp(join(tmpdir(), 'reclaw-ingress-'));
  });

  afterEach(async () => {
    await rm(attachmentDir, { recursive: true, force: true });
  });

  const photoUpdate = (photo: readonly { readonly file_id: string }[]) => ({
    from: { id: AUTHORIZED },
    chat: { id: CHAT },
    update: { update_id: 1002 },
    message: { photo, caption: 'Look' },
  });

  it('spools the largest size under its update ID, then drops it when the handler is done', async () => {
    const { deps, lifecycle, files } = makeIngress(attachmentDir);
    const spooledPath = join(attachmentDir, '1002.png');
    let spooledBytes: Uint8Array | undefined;
    lifecycle.setHandler(async (message) => {
      expect(message).toMatchObject({ updateId: 1002, text: 'Look', imagePaths: [spooledPath] });
      spooledBytes = new Uint8Array(await readFile(spooledPath));
      return { kind: 'remove-source-files' };
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(new Uint8Array([0x89, 0x50])));

    await receivePhoto(deps, photoUpdate([{ file_id: 'small' }, { file_id: 'large' }]));

    expect(files.getFile).toHaveBeenCalledWith('large');
    expect(spooledBytes).toEqual(new Uint8Array([0x89, 0x50]));
    expect(existsSync(spooledPath)).toBe(false);
  });

  it('ignores a photo update that carries no sizes', async () => {
    const { deps, lifecycle, files } = makeIngress(attachmentDir);
    const handler = vi.fn<IncomingHandler>();
    lifecycle.setHandler(handler);

    await receivePhoto(deps, photoUpdate([]));

    expect(files.getFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(lifecycle.hasFailed()).toBe(false);
  });
});
