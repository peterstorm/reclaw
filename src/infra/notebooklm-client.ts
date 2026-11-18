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
  APIError,
  NotebookLMAuthError,
  NotebookLMClient,
  NotebookLMNetworkError,
  NotebookLMParseError,
} from 'notebooklm-kit';
import { errorMessage } from '../core/error-message.js';
import { requiredGroup } from '../core/regex-group.js';
import type { ChatResponse, SourceMeta, WebSource } from '../core/research-types.js';
import type { Result } from '../core/types.js';
import { addedTextSourceId, stringField } from './notebooklm-reply.js';
import { NOTEBOOKLM_WEB_ORIGIN } from './notebooklm-web.js';

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
type AudioCustomization = {
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
  readonly addYouTubeSource: (
    notebookId: string,
    url: string,
  ) => Promise<Result<string, AdapterError>>;

  /**
   * Poll until all sources finish processing or timeout is reached.
   * FR-015 + FR-016.
   */
  readonly waitForProcessing: (
    notebookId: string,
    timeoutMs: number,
  ) => Promise<Result<void, AdapterError>>;

  /** Chat with the notebook. Returns text + citations. FR-024. */
  readonly chat: (
    notebookId: string,
    question: string,
  ) => Promise<Result<ChatResponse, AdapterError>>;

  /** List all sources in the notebook. */
  readonly listSources: (
    notebookId: string,
  ) => Promise<Result<readonly SourceMeta[], AdapterError>>;

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
  if (
    'isRetryable' in error &&
    typeof (error as Record<string, unknown>).isRetryable === 'function'
  ) {
    return (error as { isRetryable: () => boolean }).isRetryable();
  }

  // Layer 4: String heuristics for non-SDK errors (Node.js system errors, etc.)
  const msg = error.message.toLowerCase();

  if (
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('epipe') ||
    msg.includes('enotfound') ||
    msg.includes('timed out') ||
    msg.includes('fetch failed')
  ) {
    return true;
  }

  // HTTP status codes embedded in message text
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (match) {
    const code = Number.parseInt(requiredGroup(match, 1), 10);
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
    const message = errorMessage(err);
    // Log full error details for debugging SDK failures (e.g. gRPC error codes)
    const extras: Record<string, unknown> = {};
    if (err instanceof Error) {
      if ('errorCode' in err) extras.errorCode = err.errorCode;
      if ('httpStatus' in err) extras.httpStatus = err.httpStatus;
      if ('rawResponse' in err) extras.rawResponse = err.rawResponse;
    }
    console.error(
      '[notebooklm:safeCall] SDK error:',
      message,
      Object.keys(extras).length > 0 ? extras : '',
    );
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
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }

  // FR-016: report which sources are still pending so the error is actionable.
  let pendingDetail = '';
  try {
    const sources = await sdk.sources.list(notebookId);
    const pending = sources.filter((s) => {
      const status = (s as unknown as Record<string, unknown>).status as string | undefined;
      return status !== 'COMPLETE' && status !== 'ready';
    });
    if (pending.length > 0) {
      const descriptions = pending
        .map((s) => {
          const rec = s as unknown as Record<string, unknown>;
          return `"${(rec.title as string | undefined) ?? (rec.url as string | undefined) ?? s.sourceId}"`;
        })
        .join(', ');
      pendingDetail = ` Unprocessed sources (${pending.length}): ${descriptions}.`;
    }
  } catch (err) {
    console.warn('[notebooklm:processing] diagnostic list sources failed:', err);
  }

  throw new Error(`Sources did not finish processing within ${timeoutMs}ms.${pendingDetail}`);
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
    const response = await fetch(`${NOTEBOOKLM_WEB_ORIGIN}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Accept: 'text/html',
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
      console.info(`[notebooklm:bl] Detected build label: ${match[0]}`);
      return match[0];
    }
    console.warn('[notebooklm:bl] Build label not found in HTML, using fallback');
    return FALLBACK_BL;
  } catch (err) {
    console.warn('[notebooklm:bl] Fetch failed:', err instanceof Error ? err.message : err);
    return FALLBACK_BL;
  }
}

// ─── Operations ───────────────────────────────────────────────────────────────
//
// Each adapter operation is a function of the connected SDK; the factory only
// connects and wires them.

/** A failure no retry can fix: the SDK answered, but without what was asked for. */
function permanentFailure(message: string): Result<never, AdapterError> {
  return { ok: false, error: { message, retriable: false } };
}

/** The id an SDK call returned, or a permanent failure naming what was missing. */
function requiredId(id: string | null, missing: string): Result<string, AdapterError> {
  return id === null ? permanentFailure(missing) : { ok: true, value: id };
}

async function createNotebook(
  sdk: NotebookLMClient,
  title: string,
): Promise<Result<string, AdapterError>> {
  const result = await safeCall(() => sdk.notebooks.create({ title }));
  if (!result.ok) return result;
  return requiredId(
    stringField(result.value, 'projectId'),
    'NotebookLM did not return a projectId',
  );
}

async function searchWeb(
  sdk: NotebookLMClient,
  notebookId: string,
  query: string,
): Promise<Result<{ sessionId: string; webSources: WebSource[] }, AdapterError>> {
  const result = await safeCall(() => sdk.sources.searchWebAndWait(notebookId, { query }));
  if (!result.ok) return result;
  const { sessionId, web } = result.value;
  const webSources: WebSource[] = web.map((s) => ({
    title: s.title,
    url: s.url,
  }));
  return { ok: true, value: { sessionId, webSources } };
}

async function addDiscoveredSources(
  sdk: NotebookLMClient,
  notebookId: string,
  sessionId: string,
  sources: WebSource[],
  limit: number,
): Promise<Result<string[], AdapterError>> {
  const capped = sources.slice(0, limit);
  const webSources = capped.map((s) => ({ url: s.url, title: s.title }));
  return safeCall(() => sdk.sources.addDiscovered(notebookId, { sessionId, webSources }));
}

async function addSourceText(
  sdk: NotebookLMClient,
  notebookId: string,
  title: string,
  content: string,
): Promise<Result<string, AdapterError>> {
  const result = await safeCall(() => sdk.sources.addFromText(notebookId, { title, content }));
  if (!result.ok) return result;
  return requiredId(addedTextSourceId(result.value), 'addFromText returned no sourceId');
}

async function chat(
  sdk: NotebookLMClient,
  notebookId: string,
  question: string,
): Promise<Result<ChatResponse, AdapterError>> {
  const result = await safeCall(() => sdk.generation.chat(notebookId, question));
  if (!result.ok) return result;
  const data = result.value;

  const chatResponse: ChatResponse = {
    text: data.text ?? '',
    citations: data.citations ?? [],
    rawData: data.rawData ?? null,
  };
  return { ok: true, value: chatResponse };
}

async function listSources(
  sdk: NotebookLMClient,
  notebookId: string,
): Promise<Result<readonly SourceMeta[], AdapterError>> {
  const result = await safeCall(() => sdk.sources.list(notebookId));
  if (!result.ok) return result;
  const sources: SourceMeta[] = result.value.map((s) => ({
    id: s.sourceId,
    title: s.title ?? s.url ?? s.sourceId,
    url: s.url ?? '',
    sourceType: mapSourceType(s.type),
  }));
  return { ok: true, value: sources };
}

async function createAudioOverview(
  sdk: NotebookLMClient,
  notebookId: string,
  options?: { instructions?: string; customization?: AudioCustomization },
): Promise<Result<string, AdapterError>> {
  const customization = { format: 0, ...options?.customization };
  const createOpts: Record<string, unknown> = { customization };
  if (options?.instructions) createOpts.instructions = options.instructions;
  const result = await safeCall(() => sdk.artifacts.audio.create(notebookId, createOpts));
  if (!result.ok) return result;
  return requiredId(stringField(result.value, 'audioId'), 'Audio creation returned no audioId');
}

async function createVideoOverview(
  sdk: NotebookLMClient,
  notebookId: string,
  options?: { instructions?: string },
): Promise<Result<string, AdapterError>> {
  const videoOpts: Record<string, unknown> = {};
  if (options?.instructions) videoOpts.instructions = options.instructions;
  const result = await safeCall(() => sdk.artifacts.video.create(notebookId, videoOpts));
  if (!result.ok) return result;
  return requiredId(stringField(result.value, 'videoId'), 'Video creation returned no videoId');
}

/** Poll an artifact until READY or FAILED; throws once `timeoutMs` passes. */
async function pollArtifact(
  sdk: NotebookLMClient,
  artifactId: string,
  notebookId: string,
  timeoutMs: number,
): Promise<'ready' | 'failed'> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 15_000;

  while (Date.now() < deadline) {
    const artifact = await sdk.artifacts.get(artifactId, notebookId);
    const state = (artifact as { state?: number }).state;
    // ArtifactState: CREATING = 1, READY = 2, FAILED = 3
    if (state === 2) return 'ready';
    if (state === 3) return 'failed';
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }
  throw new Error(`Artifact ${artifactId} did not become ready within ${timeoutMs}ms`);
}

async function shareNotebook(
  sdk: NotebookLMClient,
  notebookId: string,
): Promise<Result<string, AdapterError>> {
  const result = await safeCall(
    () => sdk.artifacts.share(notebookId, { accessType: 1 }), // anyone with link
  );
  if (!result.ok) return result;
  return requiredId(stringField(result.value, 'shareUrl'), 'Share returned no shareUrl');
}

/** Wire every adapter operation to one connected SDK. */
function notebookLMAdapterOver(sdk: NotebookLMClient): NotebookLMAdapter {
  return {
    createNotebook: (title) => createNotebook(sdk, title),
    searchWeb: (notebookId, query) => searchWeb(sdk, notebookId, query),
    addDiscoveredSources: (notebookId, sessionId, sources, limit) =>
      addDiscoveredSources(sdk, notebookId, sessionId, sources, limit),
    addSourceUrl: (notebookId, url) => safeCall(() => sdk.sources.addFromURL(notebookId, { url })),
    addSourceText: (notebookId, title, content) => addSourceText(sdk, notebookId, title, content),
    addYouTubeSource: (notebookId, url) =>
      safeCall(() => sdk.sources.addYouTube(notebookId, { urlOrId: url })),
    waitForProcessing: (notebookId, timeoutMs) =>
      safeCall(() => pollUntilReady(sdk, notebookId, timeoutMs)),
    chat: (notebookId, question) => chat(sdk, notebookId, question),
    listSources: (notebookId) => listSources(sdk, notebookId),
    createAudioOverview: (notebookId, options) => createAudioOverview(sdk, notebookId, options),
    createVideoOverview: (notebookId, options) => createVideoOverview(sdk, notebookId, options),
    waitForArtifact: (artifactId, notebookId, timeoutMs) =>
      safeCall(() => pollArtifact(sdk, artifactId, notebookId, timeoutMs)),
    shareNotebook: (notebookId) => shareNotebook(sdk, notebookId),
    dispose: async () => {
      sdk.dispose();
    },
  } as const;
}

// ─── Connection ───────────────────────────────────────────────────────────────

function createSdk(credentials: NotebookLMCredentials, bl: string): NotebookLMClient {
  return new NotebookLMClient({
    ...(credentials.kind === 'token'
      ? { authToken: credentials.authToken, cookies: credentials.cookies }
      : { auth: { email: credentials.email, password: credentials.password, headless: true } }),
    autoRefresh: { enabled: true, interval: 10 * 60 * 1000 },
    urlParams: { bl },
  });
}

/** sdk.connect(), rejected after CONNECT_TIMEOUT_MS with a hint for the auth method in use. */
async function connectWithinTimeout(
  sdk: NotebookLMClient,
  authKind: NotebookLMCredentials['kind'],
): Promise<void> {
  console.info('[notebooklm] Calling sdk.connect()...');
  const connectStart = Date.now();
  await Promise.race([
    sdk.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `sdk.connect() timed out after ${CONNECT_TIMEOUT_MS}ms — ${
                authKind === 'google'
                  ? 'Google auto-login likely blocked by captcha. Switch to token auth (NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES).'
                  : 'token auth failed to connect.'
              }`,
            ),
          ),
        CONNECT_TIMEOUT_MS,
      ),
    ),
  ]);
  console.info(`[notebooklm] sdk.connect() succeeded in ${Date.now() - connectStart}ms`);
}

/** Verify auth by listing notebooks (fast, lightweight call); a failure disposes the SDK and throws. */
async function checkAuthHealth(sdk: NotebookLMClient): Promise<void> {
  console.info('[notebooklm] Running auth health check (notebooks.list)...');
  try {
    await sdk.notebooks.list();
    console.info('[notebooklm] Auth health check passed — adapter ready');
  } catch (healthErr) {
    const msg = errorMessage(healthErr);
    console.error(`[notebooklm] Auth health check FAILED: ${msg}`);
    sdk.dispose();
    throw new Error(`NotebookLM auth health check failed: ${msg}`);
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
  console.info(`[notebooklm] Creating adapter with auth method: ${credentials.kind}`);

  // Fetch the current build label from NotebookLM page (falls back to FALLBACK_BL)
  const sdk = createSdk(credentials, await fetchCurrentBuildLabel());
  await connectWithinTimeout(sdk, credentials.kind);
  await checkAuthHealth(sdk);
  return notebookLMAdapterOver(sdk);
}
