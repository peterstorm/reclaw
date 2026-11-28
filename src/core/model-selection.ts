import { type AgentBackendName, type Result, err, ok } from './types.js';

/** Which model an agent run uses. Pi takes both fields; Claude only reads `model`. */
export type AgentModelSelection = {
  readonly provider?: string;
  readonly model?: string;
};

/**
 * A Claude CLI `--model` value: an alias (`sonnet`, `opus`, `haiku`, `opus[1m]`) or a full id
 * (`claude-sonnet-5-5`). The leading alphanumeric means it can never parse as a CLI flag.
 */
export type ClaudeModel = string & { readonly __brand: 'ClaudeModel' };

const CLAUDE_MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-[\]]*$/i;

export function makeClaudeModel(raw: string): Result<ClaudeModel, string> {
  return CLAUDE_MODEL_PATTERN.test(raw)
    ? ok(raw as ClaudeModel)
    : err(
        `invalid Claude model "${raw}" — expected an alias or id such as "sonnet" or "claude-sonnet-5-5"`,
      );
}

/** Claude with an optional pinned model. */
export type ClaudeTarget = { readonly backend: 'claude'; readonly model?: ClaudeModel };

/**
 * A concrete agent to run a skill on. Only Claude can pin a model per skill: Pi's model is
 * service-wide (RECLAW_PI_MODEL).
 */
export type AgentTarget = { readonly backend: 'pi' } | ClaudeTarget;

/** Why a backend/model pair is not an AgentTarget. */
export type AgentTargetError =
  | { readonly kind: 'model-needs-claude' }
  | { readonly kind: 'invalid-claude-model'; readonly detail: string };

/**
 * Parse a backend and optional model into an AgentTarget — the one parser behind a skill's
 * `backend:`/`model:`/`fallback:` and the chat fallback env. Only Claude takes a model.
 */
export function makeAgentTarget(
  backend: AgentBackendName,
  model: string | undefined,
): Result<AgentTarget, AgentTargetError> {
  if (model === undefined) return ok({ backend });
  if (backend !== 'claude') return err({ kind: 'model-needs-claude' });
  const parsed = makeClaudeModel(model);
  return parsed.ok
    ? ok({ backend, model: parsed.value })
    : err({ kind: 'invalid-claude-model', detail: parsed.error });
}

/** The per-run model request a target makes (none for Pi). */
export function requestedModel(target: AgentTarget): AgentModelSelection | undefined {
  return target.backend === 'claude' && target.model !== undefined
    ? { model: target.model }
    : undefined;
}

/** Service-wide model defaults, keyed by the backend they were configured for. */
export type ServiceModelSelections = Readonly<
  Partial<Record<AgentBackendName, AgentModelSelection>>
>;

/**
 * The model selection for one run on `backend`. A per-run request (a skill's `model:`) wins
 * field by field; a service default only ever applies to its own backend — RECLAW_PI_MODEL
 * names a vLLM model and must never reach `claude --model`. Undefined means "backend default".
 */
export function resolveModelSelection(
  backend: AgentBackendName,
  requested: AgentModelSelection | undefined,
  serviceDefaults: ServiceModelSelections,
): AgentModelSelection | undefined {
  const selection = { ...serviceDefaults[backend], ...requested };
  return Object.keys(selection).length > 0 ? selection : undefined;
}

/**
 * The service defaults for scheduled runs: Pi's model replaced by `scheduledPiModel` (the
 * provider and every other backend are untouched). Unset means scheduled runs share the chat
 * defaults. Chat keeps `serviceDefaults` as is.
 */
export function scheduledModelSelections(
  serviceDefaults: ServiceModelSelections,
  scheduledPiModel: string | undefined,
): ServiceModelSelections {
  return scheduledPiModel === undefined
    ? serviceDefaults
    : { ...serviceDefaults, pi: { ...serviceDefaults.pi, model: scheduledPiModel } };
}
