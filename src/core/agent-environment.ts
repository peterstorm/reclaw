// ─── Agent Process Environment Policy ────────────────────────────────────────
//
// Agent subprocesses must not inherit Reclaw's complete service environment.
// The keys below are the closed baseline needed to start CLI processes on the
// supported NixOS host and authenticate the selected model provider. Service
// credentials (Telegram, NotebookLM, Google login, Garmin, etc.) are deliberately
// absent; scheduled skills must request those through an explicit, parsed grant.

/** Non-secret process/runtime configuration needed by agent CLIs and their tools. */
const RUNTIME_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',
  'NIX_PATH',
  'NIX_PROFILES',
  'NIX_USER_PROFILE_DIR',
  'NIX_LD',
  'NIX_LD_LIBRARY_PATH',
  'LOCALE_ARCHIVE',
  'LOCALE_ARCHIVE_2_27',
  'TERMINFO_DIRS',
  'INFOPATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

/** Provider-specific values Pi documents as alternatives to its 0600 auth file. */
const PI_PROVIDER_ENVIRONMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'azure-openai-responses': [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  ],
  openai: ['OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'amazon-bedrock': [
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
    'AWS_BEDROCK_SKIP_AUTH',
    'AWS_BEDROCK_FORCE_HTTP1',
    'AWS_BEDROCK_FORCE_CACHE',
  ],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'google-vertex': [
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
};

/** Environment names a trusted scheduled-skill config may explicitly request. */
export const SKILL_ENVIRONMENT_VARIABLES = [
  'GARMIN_EMAIL',
  'GARMIN_PASSWORD',
  'GOOGLE_EMAIL',
  'GOOGLE_PASSWORD',
  'NOTEBOOKLM_AUTH_TOKEN',
  'NOTEBOOKLM_COOKIES',
  'AGENT_BACKEND',
  'RECLAW_PI_PROVIDER',
  'RECLAW_PI_MODEL',
  'SKILLS_DIR',
] as const;

export type SkillEnvironmentVariable = (typeof SKILL_ENVIRONMENT_VARIABLES)[number];

type Environment = Readonly<Record<string, string | undefined>>;
type ProcessEnvironment = Record<string, string | undefined>;

export type AgentEnvironmentTarget = {
  readonly backend: string;
  readonly provider?: string;
};

const ALL_PI_PROVIDER_ENVIRONMENT_KEYS = [
  ...new Set(Object.values(PI_PROVIDER_ENVIRONMENT_KEYS).flat()),
];

function providerEnvironmentKeys(target: AgentEnvironmentTarget): readonly string[] {
  if (target.backend === 'claude') {
    return ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  }
  if (target.backend === 'pi') {
    // When Reclaw does not override Pi's provider, Pi resolves it from its own
    // settings. The runner cannot know which key that provider needs, so retain
    // documented Pi provider values for compatibility. Explicit provider
    // selection narrows this to that provider's keys.
    if (target.provider === undefined) return ALL_PI_PROVIDER_ENVIRONMENT_KEYS;
    return PI_PROVIDER_ENVIRONMENT_KEYS[target.provider] ?? [];
  }
  return [];
}

/** Copy defined values for a closed list of keys without retaining source references. */
function selectDefined(source: Environment, keys: readonly string[]): ProcessEnvironment {
  const selected: ProcessEnvironment = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

/**
 * Build the complete environment passed to an agent subprocess.
 *
 * Explicit values are trusted grants selected by the caller from parsed skill
 * configuration. They may override baseline values, which is useful for tests
 * and deliberate per-run provider configuration.
 */
export function buildAgentProcessEnvironment(
  inherited: Environment,
  target: AgentEnvironmentTarget,
  explicit: Readonly<Record<string, string>> = {},
): ProcessEnvironment {
  const permittedKeys = [...RUNTIME_ENVIRONMENT_KEYS, ...providerEnvironmentKeys(target)];
  return { ...selectDefined(inherited, permittedKeys), ...explicit };
}

/**
 * Resolve one skill's parsed grants from the service environment. A grant is
 * permission to pass a value when configured, not a requirement that the value
 * exist: several scripts intentionally support credential-file fallbacks.
 */
export function resolveSkillEnvironment(
  inherited: Environment,
  grants: readonly SkillEnvironmentVariable[],
): Readonly<Record<string, string>> {
  return selectDefined(inherited, grants) as Readonly<Record<string, string>>;
}
