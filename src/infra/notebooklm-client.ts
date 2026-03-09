// ─── NotebookLM Client Adapter ────────────────────────────────────────────────
//
// Thin singleton adapter over the notebooklm-kit SDK.
//
// FR-010: System MUST create one NotebookLM notebook per research topic.
// FR-011: System MUST perform a web search via the NotebookLM SDK.
// FR-012: System MUST add the top 10 discovered web sources.
// FR-013: System MUST parse user-provided source hint URLs.
// FR-014: System MUST support YouTube URLs and web URLs as source hint types.
// FR-015: System MUST wait for all added sources to complete processing.
// FR-016: System MUST enforce a maximum wait time of 10 minutes.
// FR-024: System MUST track the number of NotebookLM chat calls consumed.
// FR-070: Auth via NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES env vars.

import { NotebookLMClient } from 'notebooklm-kit';
import type { Result } from '../core/types.js';
import type { SourceMeta, ChatResponse, WebSource } from '../core/research-types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Richer error type for adapter operations.
 * Carries the error message plus a flag indicating whether the operation
 * can be safely retried (network/5xx) or is permanent (4xx).
 */
export type AdapterError = {
  readonly message: string;
  readonly retriable: boolean;
};

/** The public adapter interface over the NotebookLM SDK. */
export type NotebookLMAdapter = {
  /** Create a new notebook and return its project ID. */
  readonly createNotebook: (title: string) => Promise<Result<string, AdapterError>>;

  /**
   * Perform a web search and return the session ID + discovered web sources.
   * FR-011: web search via the NotebookLM SDK.
   */
  readonly searchWeb: (
    notebookId: string,
    query: string,
  ) => Promise<Result<{ sessionId: string; webSources: WebSource[] }, AdapterError>>;

  /**
   * Add the selected discovered sources to the notebook.
   * FR-012: add top discovered sources (limit enforced by caller).
   */
  readonly addDiscoveredSources: (
    notebookId: string,
    sessionId: string,
    sources: WebSource[],
    limit: number,
  ) => Promise<Result<string[], AdapterError>>;

  /**
   * Add a plain web URL as a source.
   * FR-013: add explicit source hint URLs.
   */
  readonly addSourceUrl: (notebookId: string, url: string) => Promise<Result<string, AdapterError>>;

  /**
   * Add a YouTube URL as a source.
   * FR-014: support YouTube URLs.
   */
  readonly addYouTubeSource: (notebookId: string, url: string) => Promise<Result<string, AdapterError>>;

  /**
   * Poll until all sources finish processing or timeout is reached.
   * FR-015 + FR-016.
   */
  readonly waitForProcessing: (
    notebookId: string,
    timeoutMs: number,
  ) => Promise<Result<void, AdapterError>>;

  /** Chat with the notebook. Returns text + citations. FR-024. */
  readonly chat: (notebookId: string, question: string) => Promise<Result<ChatResponse, AdapterError>>;

  /** List all sources in the notebook. */
  readonly listSources: (notebookId: string) => Promise<Result<readonly SourceMeta[], AdapterError>>;

  /** Dispose of the client and stop auto-refresh. */
  readonly dispose: () => Promise<void>;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Map a notebooklm-kit SourceType code to our SourceMeta.sourceType.
 * Unknown/unrecognized types default to 'web'.
 */
export function mapSourceType(
  type: number | string | undefined,
): 'youtube' | 'web' | 'pdf' | 'text' {
  // notebooklm-kit SourceType enum values:
  //   YOUTUBE_VIDEO = 4, PDF = 7, TEXT = 2 / TEXT_NOTE = 8
  const num = typeof type === 'number' ? type : Number(type);
  if (num === 4) return 'youtube';
  if (num === 3 || num === 7 || num === 14) return 'pdf';
  if (num === 2 || num === 8) return 'text';
  return 'web';
}

/**
 * Classify an error as retriable or not.
 * Network errors and 5xx codes are retriable; 4xx are permanent.
 * Unknown errors default to NON-retriable (safe default — do not retry blindly).
 */
export function isRetriableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('etimedout')) {
      return true;
    }
    // Check for status codes in message
    const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) {
      const code = parseInt(match[1]!, 10);
      return code >= 500;
    }
    // Default: do NOT retry unknown errors
    return false;
  }
  // Non-Error throwables: do NOT retry
  return false;
}

/** Wrap an SDK call and catch all errors, returning Result<T, AdapterError>. */
async function safeCall<T>(fn: () => Promise<T>): Promise<Result<T, AdapterError>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message, retriable: isRetriableError(err) } };
  }
}

/** Poll for source processing with a deadline. Throws with unprocessed source details on timeout. */
async function pollUntilReady(
  sdk: NotebookLMClient,
  notebookId: string,
  timeoutMs: number,
  pollIntervalMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sdk.sources.status(notebookId);
    if (status.allReady) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
    );
  }

  // FR-016: report which sources are still pending so the error is actionable.
  let pendingDetail = '';
  try {
    const sources = await sdk.sources.list(notebookId);
    const pending = sources.filter(
      (s) => (s as unknown as { status?: string }).status !== 'COMPLETE' && (s as unknown as { status?: string }).status !== 'ready',
    );
    if (pending.length > 0) {
      const descriptions = pending
        .map(
          (s) => `"${(s as unknown as { title?: string }).title ?? (s as unknown as { url?: string }).url ?? s.sourceId}"`,
        )
        .join(', ');
      pendingDetail = ` Unprocessed sources (${pending.length}): ${descriptions}.`;
    }
  } catch (err) {
    console.warn('[notebooklm:processing] diagnostic list sources failed:', err);
  }

  throw new Error(
    `Sources did not finish processing within ${timeoutMs}ms.${pendingDetail}`,
  );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a NotebookLM adapter.
 *
 * FR-070: Auth credentials come from NOTEBOOKLM_AUTH_TOKEN and NOTEBOOKLM_COOKIES
 * env vars (SDK reads them automatically via createNotebookLMClient).
 *
 * AD-5: The SDK starts an auto-refresh timer — create once, reuse across jobs.
 *
 * @param authToken - value of NOTEBOOKLM_AUTH_TOKEN
 * @param cookies   - value of NOTEBOOKLM_COOKIES
 */
export async function createNotebookLMAdapter(
  authToken: string,
  cookies: string,
): Promise<NotebookLMAdapter> {
  const sdk = new NotebookLMClient({
    authToken,
    cookies,
    autoRefresh: { enabled: true, interval: 10 * 60 * 1000 },
  });

  await sdk.connect();

  // ─── createNotebook ────────────────────────────────────────────────────────

  const createNotebook = async (title: string): Promise<Result<string, AdapterError>> => {
    const result = await safeCall(() => sdk.notebooks.create({ title }));
    if (!result.ok) return result;
    const notebookId: string = result.value.projectId;
    if (!notebookId) {
      return { ok: false, error: { message: 'NotebookLM did not return a projectId', retriable: false } };
    }
    return { ok: true, value: notebookId };
  };

  // ─── searchWeb ─────────────────────────────────────────────────────────────

  const searchWeb = async (
    notebookId: string,
    query: string,
  ): Promise<Result<{ sessionId: string; webSources: WebSource[] }, AdapterError>> => {
    const result = await safeCall(() =>
      sdk.sources.searchWebAndWait(notebookId, { query }),
    );
    if (!result.ok) return result;
    const { sessionId, web } = result.value;
    const webSources: WebSource[] = web.map((s) => ({
      title: s.title,
      url: s.url,
    }));
    return { ok: true, value: { sessionId, webSources } };
  };

  // ─── addDiscoveredSources ──────────────────────────────────────────────────

  const addDiscoveredSources = async (
    notebookId: string,
    sessionId: string,
    sources: WebSource[],
    limit: number,
  ): Promise<Result<string[], AdapterError>> => {
    const capped = sources.slice(0, limit);
    const webSources = capped.map((s) => ({ url: s.url, title: s.title }));
    const result = await safeCall(() =>
      sdk.sources.addDiscovered(notebookId, { sessionId, webSources }),
    );
    return result;
  };

  // ─── addSourceUrl ──────────────────────────────────────────────────────────

  const addSourceUrl = async (
    notebookId: string,
    url: string,
  ): Promise<Result<string, AdapterError>> => {
    const result = await safeCall(() =>
      sdk.sources.addFromURL(notebookId, { url }),
    );
    return result;
  };

  // ─── addYouTubeSource ──────────────────────────────────────────────────────

  const addYouTubeSource = async (
    notebookId: string,
    url: string,
  ): Promise<Result<string, AdapterError>> => {
    const result = await safeCall(() =>
      sdk.sources.addYouTube(notebookId, { urlOrId: url }),
    );
    return result;
  };

  // ─── waitForProcessing ─────────────────────────────────────────────────────

  const waitForProcessing = async (
    notebookId: string,
    timeoutMs: number,
  ): Promise<Result<void, AdapterError>> => {
    return safeCall(() => pollUntilReady(sdk, notebookId, timeoutMs));
  };

  // ─── chat ──────────────────────────────────────────────────────────────────

  const chat = async (
    notebookId: string,
    question: string,
  ): Promise<Result<ChatResponse, AdapterError>> => {
    const result = await safeCall(() => sdk.generation.chat(notebookId, question));
    if (!result.ok) return result;
    const data = result.value;
    const chatResponse: ChatResponse = {
      text: data.text ?? '',
      citations: data.citations ?? [],
      rawData: data.rawData ?? null,
    };
    return { ok: true, value: chatResponse };
  };

  // ─── listSources ───────────────────────────────────────────────────────────

  const listSources = async (
    notebookId: string,
  ): Promise<Result<readonly SourceMeta[], AdapterError>> => {
    const result = await safeCall(() => sdk.sources.list(notebookId));
    if (!result.ok) return result;
    const sources: SourceMeta[] = result.value.map((s) => ({
      id: s.sourceId,
      title: s.title ?? s.url ?? s.sourceId,
      url: s.url ?? '',
      sourceType: mapSourceType(s.type),
    }));
    return { ok: true, value: sources };
  };

  // ─── dispose ───────────────────────────────────────────────────────────────

  const dispose = async (): Promise<void> => {
    sdk.dispose();
  };

  return {
    createNotebook,
    searchWeb,
    addDiscoveredSources,
    addSourceUrl,
    addYouTubeSource,
    waitForProcessing,
    chat,
    listSources,
    dispose,
  } as const;
}
