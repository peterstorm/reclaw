export const NOTEBOOKLM_WEB_ORIGIN = 'https://notebook.google.com';
export const NOTEBOOKLM_LEGACY_WEB_ORIGIN = 'https://notebooklm.google.com';
export const NOTEBOOKLM_WEB_ORIGINS = [
  NOTEBOOKLM_WEB_ORIGIN,
  NOTEBOOKLM_LEGACY_WEB_ORIGIN,
] as const;

/** Accept NotebookLM's current host and its legacy host without trusting lookalike domains. */
export function isNotebookLMWebUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return NOTEBOOKLM_WEB_ORIGINS.some((origin) => url.origin === origin);
  } catch {
    return false;
  }
}
