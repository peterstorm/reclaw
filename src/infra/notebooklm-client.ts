// ─── NotebookLM Client Adapter ────────────────────────────────────────────────
//
// Thin singleton adapter over the notebooklm-kit SDK.
//
// FR-010: System MUST create one NotebookLM notebook per research topic.
// FR-011: System MUST perform a web search via the NotebookLM SDK.
// FR-012: System MUST add the top discovered web sources (capped by MAX_DISCOVERED_SOURCES).
// FR-013: System MUST parse user-provided source hint URLs.
// FR-014: System MUST support YouTube URLs and web URLs as source hint types.
// FR-015: System MUST wait for all added sources to complete processing.
// FR-016: System MUST enforce a maximum wait time of 10 minutes.
// FR-024: System MUST track the number of NotebookLM chat calls consumed.
// FR-070: Auth via NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES env vars,
//         or GOOGLE_EMAIL + GOOGLE_PASSWORD for auto browser login (no 2FA).

import {
  NotebookLMClient,
  APIError,
  NotebookLMNetworkError,
  NotebookLMAuthError,
  NotebookLMParseError,
} from 'notebooklm-kit';
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

/** Audio overview customization options. */
export type AudioCustomization = {
  /** 0=Deep Dive, 1=Brief, 2=Critique, 3=Debate */
  readonly format?: 0 | 1 | 2 | 3;
  /** 1=Short, 2=Default, 3=Long */
  readonly length?: 1 | 2 | 3;
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

  /** Add raw text as a source (e.g. an Obsidian note). */
  readonly addSourceText: (
    notebookId: string,
    title: string,
    content: string,
  ) => Promise<Result<string, AdapterError>>;

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

  /** Create an audio overview artifact. Returns the artifact ID. */
  readonly createAudioOverview: (
    notebookId: string,
    options?: { instructions?: string; customization?: AudioCustomization },
  ) => Promise<Result<string, AdapterError>>;

  /** Create a video overview artifact. Returns the artifact ID. */
  readonly createVideoOverview: (
    notebookId: string,
    options?: { instructions?: string },
  ) => Promise<Result<string, AdapterError>>;

  /** Poll an artifact until READY or FAILED. Returns the final state. */
  readonly waitForArtifact: (
    artifactId: string,
    notebookId: string,
    timeoutMs: number,
  ) => Promise<Result<'ready' | 'failed', AdapterError>>;

  /** Share notebook publicly and return the share URL. */
  readonly shareNotebook: (notebookId: string) => Promise<Result<string, AdapterError>>;

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
 *
 * Layered strategy (most specific → least specific):
 *   1. SDK typed subclasses (NotebookLMNetworkError, AuthError, ParseError)
 *   2. SDK APIError with isRetryable() (checks errorCode.retryable → httpStatus)
 *   3. Duck-type fallback — any error with an isRetryable() method
 *   4. String heuristics for non-SDK errors (Node.js system errors, etc.)
 *
 * Unknown errors default to NON-retriable (safe default — do not retry blindly).
 */
export function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Layer 1: SDK typed error subclasses (most specific)
  if (error instanceof NotebookLMNetworkError) return true;
  if (error instanceof NotebookLMAuthError) return false;
  if (error instanceof NotebookLMParseError) return false;

  // Layer 2: APIError with rich metadata
  // isRetryable() checks errorCode.retryable first, then falls back to
  // httpStatus in [429, 500, 502, 503, 504]
  if (error instanceof APIError) {
    return error.isRetryable();
  }

  // Layer 3: Duck-type fallback for future SDK versions or other libraries
  if ('isRetryable' in error && typeof (error as any).isRetryable === 'function') {
    return (error as any).isRetryable();
  }

  // Layer 4: String heuristics for non-SDK errors (Node.js system errors, etc.)
  const msg = error.message.toLowerCase();

  if (
    msg.includes('network') || msg.includes('econnrefused') || msg.includes('etimedout') ||
    msg.includes('econnreset') || msg.includes('socket hang up') || msg.includes('epipe') ||
    msg.includes('enotfound') || msg.includes('timed out') || msg.includes('fetch failed')
  ) {
    return true;
  }

  // HTTP status codes embedded in message text
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (match) {
    const code = parseInt(match[1]!, 10);
    return code === 429 || code >= 500;
  }

  // Default: do NOT retry unknown errors
  return false;
}

/** Wrap an SDK call and catch all errors, returning Result<T, AdapterError>. */
async function safeCall<T>(fn: () => Promise<T>): Promise<Result<T, AdapterError>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log full error details for debugging SDK failures (e.g. gRPC error codes)
    const extras: Record<string, unknown> = {};
    if (err instanceof Error) {
      if ('errorCode' in err) extras.errorCode = (err as any).errorCode;
      if ('httpStatus' in err) extras.httpStatus = (err as any).httpStatus;
      if ('rawResponse' in err) extras.rawResponse = (err as any).rawResponse;
    }
    console.error('[notebooklm:safeCall] SDK error:', message, Object.keys(extras).length > 0 ? extras : '');
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

/** Credentials for the NotebookLM adapter — either manual token/cookies or Google auto-login. */
export type NotebookLMCredentials =
  | { readonly kind: 'token'; readonly authToken: string; readonly cookies: string }
  | { readonly kind: 'google'; readonly email: string; readonly password: string };

/** Default timeout for sdk.connect() — Google auto-login via Playwright can hang indefinitely. */
const CONNECT_TIMEOUT_MS = 60_000;

/** Hardcoded fallback build label — update periodically when Google rotates. */
export const FALLBACK_BL = 'boq_labs-tailwind-frontend_20260325.12_p0';

/**
 * Fetch the current build label from the NotebookLM page HTML.
 * Google embeds the `bl` string in the page source; we extract it to avoid
 * stale-version PermissionDenied errors from searchWebAndWait.
 * Returns FALLBACK_BL if fetching or parsing fails.
 */
export async function fetchCurrentBuildLabel(): Promise<string> {
  try {
    const response = await fetch('https://notebooklm.google.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      console.warn(`[notebooklm:bl] Page fetch returned ${response.status}, using fallback`);
      return FALLBACK_BL;
    }
    const html = await response.text();
    const match = html.match(/boq_labs-tailwind-frontend_\d{8}\.\d+_p\d+/);
    if (match) {
      console.log(`[notebooklm:bl] Detected build label: ${match[0]}`);
      return match[0];
    }
    console.warn('[notebooklm:bl] Build label not found in HTML, using fallback');
    return FALLBACK_BL;
  } catch (err) {
    console.warn('[notebooklm:bl] Fetch failed:', err instanceof Error ? err.message : err);
    return FALLBACK_BL;
  }
}

/**
 * Create a NotebookLM adapter.
 *
 * FR-070: Auth credentials come from either:
 *   - NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES (manual, token-based), or
 *   - GOOGLE_EMAIL + GOOGLE_PASSWORD (auto browser login via Playwright, no 2FA).
 *
 * AD-5: The SDK starts an auto-refresh timer — create once, reuse across jobs.
 */
export async function createNotebookLMAdapter(
  credentials: NotebookLMCredentials,
): Promise<NotebookLMAdapter> {
  console.log(`[notebooklm] Creating adapter with auth method: ${credentials.kind}`);

  // Fetch the current build label from NotebookLM page (falls back to FALLBACK_BL)
  const bl = await fetchCurrentBuildLabel();

  const sdk = new NotebookLMClient({
    ...(credentials.kind === 'token'
      ? { authToken: credentials.authToken, cookies: credentials.cookies }
      : { auth: { email: credentials.email, password: credentials.password, headless: true } }),
    autoRefresh: { enabled: true, interval: 10 * 60 * 1000 },
    urlParams: { bl },
  });

  console.log('[notebooklm] Calling sdk.connect()...');
  const connectStart = Date.now();
  await Promise.race([
    sdk.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        `sdk.connect() timed out after ${CONNECT_TIMEOUT_MS}ms — ` +
        (credentials.kind === 'google'
          ? 'Google auto-login likely blocked by captcha. Switch to token auth (NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES).'
          : 'token auth failed to connect.'),
      )), CONNECT_TIMEOUT_MS),
    ),
  ]);
  console.log(`[notebooklm] sdk.connect() succeeded in ${Date.now() - connectStart}ms`);

  // Health check: verify auth by listing notebooks (fast, lightweight call)
  console.log('[notebooklm] Running auth health check (notebooks.list)...');
  try {
    await sdk.notebooks.list();
    console.log('[notebooklm] Auth health check passed — adapter ready');
  } catch (healthErr) {
    const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
    console.error(`[notebooklm] Auth health check FAILED: ${msg}`);
    sdk.dispose();
    throw new Error(`NotebookLM auth health check failed: ${msg}`);
  }

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

  // ─── addSourceText ───────────────────────────────────────────────────────

  const addSourceText = async (
    notebookId: string,
    title: string,
    content: string,
  ): Promise<Result<string, AdapterError>> => {
    const result = await safeCall(() =>
      sdk.sources.addFromText(notebookId, { title, content }),
    );
    if (!result.ok) return result;
    // SDK returns plain string (sourceId) for small texts, or AddSourceResult for chunked uploads
    const val = result.value;
    const sourceId = typeof val === 'string'
      ? val
      : (val as { sourceId?: string; allSourceIds?: string[]; sourceIds?: string[] }).sourceId
        ?? (val as { allSourceIds?: string[] }).allSourceIds?.[0]
        ?? (val as { sourceIds?: string[] }).sourceIds?.[0]
        ?? '';
    if (!sourceId) {
      return { ok: false, error: { message: 'addFromText returned no sourceId', retriable: false } };
    }
    return { ok: true, value: sourceId };
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

  // ─── createAudioOverview ───────────────────────────────────────────────────

  const createAudioOverview = async (
    notebookId: string,
    options?: { instructions?: string; customization?: AudioCustomization },
  ): Promise<Result<string, AdapterError>> => {
    const customization = { format: 0, ...options?.customization };
    const createOpts: Record<string, unknown> = { customization };
    if (options?.instructions) createOpts.instructions = options.instructions;
    const result = await safeCall(() =>
      sdk.artifacts.audio.create(notebookId, createOpts),
    );
    if (!result.ok) return result;
    const audioId: string = (result.value as { audioId?: string }).audioId ?? '';
    if (!audioId) {
      return { ok: false, error: { message: 'Audio creation returned no audioId', retriable: false } };
    }
    return { ok: true, value: audioId };
  };

  // ─── createVideoOverview ──────────────────────────────────────────────────

  const createVideoOverview = async (
    notebookId: string,
    options?: { instructions?: string },
  ): Promise<Result<string, AdapterError>> => {
    const videoOpts: Record<string, unknown> = {};
    if (options?.instructions) videoOpts.instructions = options.instructions;
    const result = await safeCall(() =>
      sdk.artifacts.video.create(notebookId, videoOpts),
    );
    if (!result.ok) return result;
    const videoId: string = (result.value as { videoId?: string }).videoId ?? '';
    if (!videoId) {
      return { ok: false, error: { message: 'Video creation returned no videoId', retriable: false } };
    }
    return { ok: true, value: videoId };
  };

  // ─── waitForArtifact ──────────────────────────────────────────────────────

  const waitForArtifact = async (
    artifactId: string,
    notebookId: string,
    timeoutMs: number,
  ): Promise<Result<'ready' | 'failed', AdapterError>> => {
    return safeCall(async () => {
      const deadline = Date.now() + timeoutMs;
      const pollIntervalMs = 15_000;

      while (Date.now() < deadline) {
        const artifact = await sdk.artifacts.get(artifactId, notebookId);
        const state = (artifact as { state?: number }).state;
        // ArtifactState: CREATING = 1, READY = 2, FAILED = 3
        if (state === 2) return 'ready' as const;
        if (state === 3) return 'failed' as const;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
      }
      throw new Error(`Artifact ${artifactId} did not become ready within ${timeoutMs}ms`);
    });
  };

  // ─── shareNotebook ────────────────────────────────────────────────────────

  const shareNotebook = async (
    notebookId: string,
  ): Promise<Result<string, AdapterError>> => {
    const result = await safeCall(() =>
      sdk.artifacts.share(notebookId, { accessType: 1 }), // anyone with link
    );
    if (!result.ok) return result;
    const shareUrl: string = (result.value as { shareUrl?: string }).shareUrl ?? '';
    if (!shareUrl) {
      return { ok: false, error: { message: 'Share returned no shareUrl', retriable: false } };
    }
    return { ok: true, value: shareUrl };
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
    addSourceText,
    addYouTubeSource,
    waitForProcessing,
    chat,
    listSources,
    createAudioOverview,
    createVideoOverview,
    waitForArtifact,
    shareNotebook,
    dispose,
  } as const;
}
