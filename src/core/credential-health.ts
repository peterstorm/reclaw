// ─── Credential health (functional core) ───────────────────────────────────────
//
// Pure classification and report rendering for the credential-health skill. The
// I/O shell (scripts/credential-health.ts) performs the probes and repairs; every
// *decision* it makes lives here so it can be tested without a browser, a network
// or a real Google account:
//
//   - which NotebookLM credential the runtime will actually resolve (this mirrors
//     notebooklm-kit's own priority order — get it wrong and the probe passes on a
//     credential the service never loads),
//   - whether a repair is worth attempting (and whether it would even help),
//   - how a set of outcomes renders into one Telegram alert, or into silence.
//
// Design note — why an outcome ADT instead of a boolean: a credential probe has
// five distinguishable results, and collapsing them loses the two that matter
// most. `unknown` (the probe itself could not run) must never render as healthy,
// and `repaired` must never render as an alert-worthy fault. See ProbeOutcome.

// ─── Time helpers ─────────────────────────────────────────────────────────────

export const MS_PER_HOUR = 60 * 60 * 1000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Render a duration as a single coarse unit ("3 days", "5 hours", "12 minutes").
 * Alert text is read on a phone; "2.97 days" costs attention and buys nothing.
 * Negative input is treated as zero — callers phrase direction ("in X" / "X ago").
 */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms);
  const days = Math.floor(abs / MS_PER_DAY);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  const hours = Math.floor(abs / MS_PER_HOUR);
  if (hours >= 1) return hours === 1 ? '1 hour' : `${hours} hours`;
  const minutes = Math.floor(abs / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// ─── Probe outcomes ───────────────────────────────────────────────────────────

export type CredentialId = 'notebooklm' | 'garmin' | 'agent-claude' | 'agent-pi';

export const CREDENTIAL_LABELS: Record<CredentialId, string> = {
  notebooklm: 'NotebookLM',
  garmin: 'Garmin Connect',
  'agent-claude': 'Claude OAuth (agent backend)',
  'agent-pi': 'Pi provider token (agent backend)',
};

/**
 * The result of probing one credential.
 *
 * `unknown` is deliberately distinct from `healthy`: a probe that could not run
 * (binary missing, malformed store, no expiry recorded) tells us nothing about
 * the credential, and reporting it as healthy is precisely the silent failure
 * this skill exists to remove. It is likewise distinct from `broken`, so a
 * probe-side defect never sends the user chasing a credential that is fine.
 *
 * `repaired` records a fault that this run already fixed. It is reported — the
 * user should know a re-auth happened — but it is not a call to action, so it
 * never carries a remedy.
 */
export type ProbeOutcome =
  | { readonly kind: 'healthy'; readonly detail: string }
  | { readonly kind: 'repaired'; readonly detail: string }
  | { readonly kind: 'expiring'; readonly detail: string; readonly remedy: string }
  | { readonly kind: 'broken'; readonly detail: string; readonly remedy: string }
  | { readonly kind: 'unknown'; readonly detail: string };

export type Probe = {
  readonly id: CredentialId;
  readonly outcome: ProbeOutcome;
};

/** Severity order for report lines. Lower sorts first; `healthy` never renders. */
const SEVERITY: Record<ProbeOutcome['kind'], number> = {
  broken: 0,
  expiring: 1,
  unknown: 2,
  repaired: 3,
  healthy: 4,
};

const ICON: Record<ProbeOutcome['kind'], string> = {
  broken: '🔴',
  expiring: '🟡',
  unknown: '⚪',
  repaired: '🔧',
  healthy: '🟢',
};

// ─── NotebookLM credential resolution ─────────────────────────────────────────

/**
 * Where the NotebookLM credential the *runtime* will use comes from.
 *
 * `origin` matters for more than reporting: notebooklm-kit resolves env vars
 * BEFORE the saved credentials.json (auth.js `getCredentials`), so when the
 * origin is `env` a re-auth is pointless — it rewrites a file the SDK will not
 * read. Modelling the origin is what lets decideNotebookLMRepair refuse to
 * "fix" a fault it cannot fix.
 *
 * `ageDays` is null for env-provided credentials: an env var has no mtime, so
 * the staleness gate simply does not apply to it.
 */
export type NotebookLMSource =
  | {
      readonly kind: 'token';
      readonly origin: 'env' | 'file';
      readonly authToken: string;
      readonly cookies: string;
      readonly ageDays: number | null;
    }
  | { readonly kind: 'absent'; readonly reason: string };

/** Raw credentials.json as written by scripts/notebooklm-reauth.ts. */
export type CredentialsFile = {
  readonly content: string;
  readonly mtimeMs: number;
};

/**
 * Mirror notebooklm-kit's credential priority (auth.js `getCredentials`):
 *   1. explicitly provided  — reclaw never passes these for the runtime path
 *   2. NOTEBOOKLM_AUTH_TOKEN + NOTEBOOKLM_COOKIES
 *   3. credentials.json in the process cwd
 *   4. Google auto-login via Playwright
 *
 * Step 4 is reported as `absent` rather than as a source: on this host the SDK's
 * own login flow does not work (Google serves WebLiteSignIn, whose email field
 * the SDK never finds — the reason scripts/notebooklm-reauth.ts exists), so a
 * run that reaches step 4 is a fault to repair, not a credential to probe.
 *
 * Note the SDK never validates a saved credential before returning it, which is
 * exactly how an expired credentials.json takes down research jobs silently.
 */
export function resolveNotebookLMSource(
  env: {
    readonly NOTEBOOKLM_AUTH_TOKEN?: string | undefined;
    readonly NOTEBOOKLM_COOKIES?: string | undefined;
  },
  file: CredentialsFile | null,
  nowMs: number,
): NotebookLMSource {
  const envToken = env.NOTEBOOKLM_AUTH_TOKEN;
  const envCookies = env.NOTEBOOKLM_COOKIES;
  if (envToken && envCookies) {
    return {
      kind: 'token',
      origin: 'env',
      authToken: envToken,
      cookies: envCookies,
      ageDays: null,
    };
  }

  if (file === null) {
    return { kind: 'absent', reason: 'no credentials.json and no NOTEBOOKLM_* env vars' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return { kind: 'absent', reason: 'credentials.json is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'absent', reason: 'credentials.json is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const authToken = record.authToken;
  const cookies = record.cookies;
  if (typeof authToken !== 'string' || authToken === '') {
    return { kind: 'absent', reason: 'credentials.json has no authToken' };
  }
  if (typeof cookies !== 'string' || cookies === '') {
    return { kind: 'absent', reason: 'credentials.json has no cookies' };
  }

  return {
    kind: 'token',
    origin: 'file',
    authToken,
    cookies,
    ageDays: Math.max(0, (nowMs - file.mtimeMs) / MS_PER_DAY),
  };
}

// ─── Repair decisions ─────────────────────────────────────────────────────────

export type RepairDecision =
  | { readonly kind: 'attempt'; readonly reason: string }
  | { readonly kind: 'skip'; readonly reason: string };

/**
 * Gate an otherwise-needed repair on the cooldown. Both repair paths drive a
 * real remote login (Google via Playwright, Garmin via username/password), so a
 * persistently failing credential must not be retried on every manual `/run` —
 * that is how an account gets rate-limited or locked.
 */
function applyCooldown(
  reason: string,
  lastAttemptMs: number | null,
  cooldownMs: number,
  nowMs: number,
): RepairDecision {
  if (lastAttemptMs !== null && nowMs - lastAttemptMs < cooldownMs) {
    const remaining = cooldownMs - (nowMs - lastAttemptMs);
    return {
      kind: 'skip',
      reason: `${reason}, but the last repair attempt was ${formatDuration(nowMs - lastAttemptMs)} ago — cooling down for another ${formatDuration(remaining)}`,
    };
  }
  return { kind: 'attempt', reason };
}

/** Probe result for the NotebookLM credential, before any repair. */
export type NotebookLMProbe = 'ok' | 'failed' | 'not-run';

/**
 * Decide whether to re-authenticate NotebookLM.
 *
 * Two triggers, one veto:
 *   - trigger: the probe failed, or there is no usable credential at all;
 *   - trigger: the credential is older than `staleAfterDays`. The cookies expire
 *     on a ~24-day clock, so refreshing at ~20 days converts a hard failure into
 *     no failure — the point of the age gate is to never see the probe fail;
 *   - veto: the runtime resolves the credential from the environment, where a
 *     re-auth writes a file the SDK will not read.
 */
export function decideNotebookLMRepair(input: {
  readonly source: NotebookLMSource;
  readonly probe: NotebookLMProbe;
  readonly staleAfterDays: number;
  readonly lastAttemptMs: number | null;
  readonly cooldownMs: number;
  readonly nowMs: number;
}): RepairDecision {
  const { source, probe, staleAfterDays, lastAttemptMs, cooldownMs, nowMs } = input;

  if (source.kind === 'token' && source.origin === 'env') {
    if (probe === 'failed') {
      return {
        kind: 'skip',
        reason:
          'credentials come from NOTEBOOKLM_AUTH_TOKEN/NOTEBOOKLM_COOKIES, which override credentials.json — re-auth would write a file the SDK never reads',
      };
    }
    return { kind: 'skip', reason: 'env-provided credentials are healthy' };
  }

  if (source.kind === 'absent') {
    return applyCooldown(
      `no usable credential (${source.reason})`,
      lastAttemptMs,
      cooldownMs,
      nowMs,
    );
  }

  if (probe === 'failed') {
    return applyCooldown('the auth probe failed', lastAttemptMs, cooldownMs, nowMs);
  }

  if (source.ageDays !== null && source.ageDays >= staleAfterDays) {
    return applyCooldown(
      `credentials.json is ${Math.floor(source.ageDays)} days old (refresh at ${staleAfterDays}, cookies die at ~24)`,
      lastAttemptMs,
      cooldownMs,
      nowMs,
    );
  }

  return { kind: 'skip', reason: 'credential is valid and fresh' };
}

/** Probe result for the cached Garmin OAuth tokens, before any repair. */
export type GarminProbe = 'ok' | 'failed' | 'no-tokens';

/**
 * Decide whether to re-login to Garmin.
 *
 * Garmin is the one credential in the fleet that already self-heals: garmin-fetch
 * loads the cached tokens, verifies them, and falls back to a full login on
 * failure. So a failing cached token is NOT news — it is the normal expiry path,
 * and the 20:00 sync would fix it. What is news is whether that fallback still
 * works, i.e. whether GARMIN_EMAIL/GARMIN_PASSWORD are still valid. That is only
 * learnable by attempting the login, so the repair *is* the probe, and it runs
 * only on the branch where the cached token has already failed — never daily.
 *
 * There is deliberately no "are the login credentials configured?" input: the
 * Garmin client constructor rejects an empty username or password outright, so
 * holding a client at all is proof the pair exists. The shell reports `unknown`
 * when it cannot construct one, and this decision is never reached.
 */
export function decideGarminRepair(input: {
  readonly probe: GarminProbe;
  readonly lastAttemptMs: number | null;
  readonly cooldownMs: number;
  readonly nowMs: number;
}): RepairDecision {
  const { probe, lastAttemptMs, cooldownMs, nowMs } = input;

  if (probe === 'ok') return { kind: 'skip', reason: 'cached tokens are valid' };

  const reason =
    probe === 'no-tokens' ? 'no cached tokens' : 'cached tokens were rejected by Garmin';
  return applyCooldown(reason, lastAttemptMs, cooldownMs, nowMs);
}

// ─── OAuth expiry classification ──────────────────────────────────────────────

/**
 * Expiry timestamps read from an agent backend's credential store. Both are
 * nullable because the two stores differ: the Claude store records an access
 * expiry AND a refresh expiry, while the Pi store records only an access expiry
 * per provider (there is no field for when the refresh chain itself dies).
 */
export type OAuthExpiry = {
  readonly accessExpiresAtMs: number | null;
  readonly refreshExpiresAtMs: number | null;
};

/**
 * Classify an agent-backend OAuth credential from its expiry timestamps.
 *
 * The access token is deliberately NOT alarming on its own — every backend here
 * renews it silently from the refresh token, so an expired access token with a
 * live refresh token is a healthy steady state. The cliff that took down 9 chat
 * sessions on 2026-07-20 is the *refresh* expiry: past that, only an interactive
 * re-login helps, which is why it is the only signal escalated to `broken`.
 */
export function classifyOAuthExpiry(input: {
  readonly expiry: OAuthExpiry;
  readonly warnWithinMs: number;
  readonly remedy: string;
  readonly nowMs: number;
}): ProbeOutcome {
  const { expiry, warnWithinMs, remedy, nowMs } = input;
  const { accessExpiresAtMs, refreshExpiresAtMs } = expiry;

  if (refreshExpiresAtMs !== null) {
    if (refreshExpiresAtMs <= nowMs) {
      return {
        kind: 'broken',
        detail: `the refresh token expired ${formatDuration(nowMs - refreshExpiresAtMs)} ago — the backend cannot renew itself`,
        remedy,
      };
    }
    if (refreshExpiresAtMs - nowMs <= warnWithinMs) {
      return {
        kind: 'expiring',
        detail: `the refresh token expires in ${formatDuration(refreshExpiresAtMs - nowMs)}`,
        remedy,
      };
    }
    return {
      kind: 'healthy',
      detail: `refresh token valid for ${formatDuration(refreshExpiresAtMs - nowMs)}`,
    };
  }

  if (accessExpiresAtMs === null) {
    return { kind: 'unknown', detail: 'the credential store records no expiry' };
  }
  if (accessExpiresAtMs <= nowMs) {
    return {
      kind: 'broken',
      detail: `the access token expired ${formatDuration(nowMs - accessExpiresAtMs)} ago and no refresh expiry is recorded`,
      remedy,
    };
  }
  if (accessExpiresAtMs - nowMs <= warnWithinMs) {
    return {
      kind: 'expiring',
      detail: `the access token expires in ${formatDuration(accessExpiresAtMs - nowMs)} and no refresh expiry is recorded`,
      remedy,
    };
  }
  return {
    kind: 'healthy',
    detail: `access token valid for ${formatDuration(accessExpiresAtMs - nowMs)}`,
  };
}

/**
 * Read the Claude Code OAuth expiries out of ~/.claude/.credentials.json.
 * Returns null when the store is unreadable in the shape we expect, so the
 * caller reports `unknown` instead of inventing a healthy verdict.
 */
export function parseClaudeCredentials(content: string): OAuthExpiry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (oauth === null || typeof oauth !== 'object') return null;
  const record = oauth as Record<string, unknown>;
  const access = record.expiresAt;
  const refresh = record.refreshTokenExpiresAt;
  return {
    accessExpiresAtMs: typeof access === 'number' ? access : null,
    refreshExpiresAtMs: typeof refresh === 'number' ? refresh : null,
  };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

export type Report =
  | { readonly kind: 'all-clear' }
  | { readonly kind: 'alert'; readonly message: string };

/**
 * Render probes into the message the skill sends, or all-clear for silence.
 *
 * An empty probe list renders as an alert, not as all-clear: a run that probed
 * nothing has failed to do its job, and the whole point of this skill is that
 * "no news" must mean "checked and fine", never "did not look".
 */
export function renderReport(probes: readonly Probe[]): Report {
  if (probes.length === 0) {
    return {
      kind: 'alert',
      message: '🔴 credential-health probed nothing — the run is broken, not the credentials.',
    };
  }

  const notable = probes
    .filter((p) => p.outcome.kind !== 'healthy')
    .sort((a, b) => SEVERITY[a.outcome.kind] - SEVERITY[b.outcome.kind]);

  if (notable.length === 0) return { kind: 'all-clear' };

  const lines = notable.map((probe) => {
    const { outcome } = probe;
    const head = `${ICON[outcome.kind]} ${CREDENTIAL_LABELS[probe.id]} — ${outcome.detail}`;
    return outcome.kind === 'expiring' || outcome.kind === 'broken'
      ? `${head}\n   → ${outcome.remedy}`
      : head;
  });

  return { kind: 'alert', message: `*Credential health*\n\n${lines.join('\n')}` };
}
