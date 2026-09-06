import { describe, expect, it } from 'vitest';
import {
  NOTEBOOKLM_LEGACY_WEB_ORIGIN,
  NOTEBOOKLM_WEB_ORIGIN,
  isNotebookLMWebUrl,
} from './notebooklm-web.js';

describe('isNotebookLMWebUrl', () => {
  it.each([
    `${NOTEBOOKLM_WEB_ORIGIN}/?pli=1`,
    `${NOTEBOOKLM_WEB_ORIGIN}/notebook/abc`,
    `${NOTEBOOKLM_LEGACY_WEB_ORIGIN}/`,
  ])('accepts a real NotebookLM URL: %s', (url) => {
    expect(isNotebookLMWebUrl(url)).toBe(true);
  });

  it.each([
    'https://notebook.google.com.evil.example/',
    'https://notebooklm-google.com/',
    'http://notebook.google.com/',
    'not a URL',
  ])('rejects a non-NotebookLM URL: %s', (url) => {
    expect(isNotebookLMWebUrl(url)).toBe(false);
  });
});
