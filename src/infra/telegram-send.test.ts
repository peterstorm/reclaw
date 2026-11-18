import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramSender } from './telegram-send.js';

// ─── Fake Bot API ─────────────────────────────────────────────────────────────
//
// createTelegramSender takes only the two Bot API methods it calls, so a plain
// object of fakes stands in for grammY. Each fake call answers from a script.

type SenderApi = Parameters<typeof createTelegramSender>[0];

/** The shape grammY's GrammyError has for a Telegram 429 response. */
const rateLimited = (retryAfter: number) => ({
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after: retryAfter },
});

function fakeApi() {
  const sendMessage = vi.fn();
  const editMessageText = vi.fn();
  const api = { sendMessage, editMessageText } as unknown as SenderApi;
  return { api, sendMessage, editMessageText };
}

describe('createTelegramSender — 429 rate-limit retry', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it("waits Telegram's retry_after before retrying, then returns the sent message id", async () => {
    const { api, sendMessage } = fakeApi();
    sendMessage.mockRejectedValueOnce(rateLimited(2)).mockResolvedValueOnce({ message_id: 77 });
    const sender = createTelegramSender(api);

    const sending = sender.sendMessage(5, 'hello', { plain: true });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(sending).resolves.toBe(77);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, 5, 'hello');
    expect(warn).toHaveBeenCalledWith(
      '[telegram] 429 rate-limited on sendMessage, retrying in 2s (attempt 1/3)',
    );
  });

  it('falls back to the 1s, 2s, 4s backoff when retry_after is not positive', async () => {
    const { api, sendMessage } = fakeApi();
    sendMessage
      .mockRejectedValueOnce(rateLimited(0))
      .mockRejectedValueOnce(rateLimited(-1))
      .mockRejectedValueOnce(rateLimited(0))
      .mockResolvedValueOnce({ message_id: 9 });
    const sender = createTelegramSender(api);

    const sending = sender.sendMessage(5, 'hello', { plain: true });
    const callsAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return sendMessage.mock.calls.length;
    };

    expect(await callsAfter(999)).toBe(1);
    expect(await callsAfter(1)).toBe(2);
    expect(await callsAfter(1_999)).toBe(2);
    expect(await callsAfter(1)).toBe(3);
    expect(await callsAfter(3_999)).toBe(3);
    expect(await callsAfter(1)).toBe(4);
    await expect(sending).resolves.toBe(9);
  });

  it('rethrows the last 429 once its three retries are exhausted', async () => {
    const { api, sendMessage } = fakeApi();
    const last = rateLimited(1);
    sendMessage
      .mockRejectedValueOnce(rateLimited(1))
      .mockRejectedValueOnce(rateLimited(1))
      .mockRejectedValueOnce(rateLimited(1))
      .mockRejectedValueOnce(last);
    const sender = createTelegramSender(api);

    const sending = sender.sendMessage(5, 'hello', { plain: true });
    const rejection = expect(sending).rejects.toBe(last);
    await vi.advanceTimersByTimeAsync(3_000);

    await rejection;
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry an error that is not a 429', async () => {
    const { api, sendMessage } = fakeApi();
    const failure = Object.assign(new Error('Bad Request: chat not found'), { error_code: 400 });
    sendMessage.mockRejectedValueOnce(failure);
    const sender = createTelegramSender(api);

    await expect(sender.sendMessage(5, 'hello', { plain: true })).rejects.toBe(failure);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries a rate-limited edit the same way', async () => {
    const { api, editMessageText } = fakeApi();
    editMessageText.mockRejectedValueOnce(rateLimited(3)).mockResolvedValueOnce({});
    const sender = createTelegramSender(api);

    const editing = sender.editMessage(5, 42, 'final', { plain: true });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(editMessageText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(editing).resolves.toBeUndefined();
    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[telegram] 429 rate-limited on editMessage, retrying in 3s (attempt 1/3)',
    );
  });
});
