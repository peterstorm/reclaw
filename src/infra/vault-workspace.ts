import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../core/error-message.js';
import type { Result } from '../core/types.js';
import { assertNever, err, ok } from '../core/types.js';
import type { VaultFilePath, VaultRelativePath } from '../core/vault-path.js';

export type VaultPathError =
  | { readonly kind: 'vault-root-unavailable'; readonly root: string; readonly cause: string }
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'not-a-file'; readonly path: string }
  | { readonly kind: 'outside-vault'; readonly path: string }
  | { readonly kind: 'filesystem-error'; readonly path: string; readonly cause: string };

export type VaultWorkspace = {
  readonly root: string;
  readonly resolveExistingFile: (
    relativePath: VaultRelativePath,
  ) => Promise<Result<VaultFilePath, VaultPathError>>;
  readonly resolveFileForWrite: (
    relativePath: VaultRelativePath,
  ) => Promise<Result<VaultFilePath, VaultPathError>>;
  readonly resolveExistingAbsoluteFile: (
    absolutePath: string,
  ) => Promise<Result<VaultFilePath, VaultPathError>>;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/** Segment-aware containment; string prefix checks are incorrect for roots such as /vault and /vault-old. */
function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function outside(pathValue: string): Result<never, VaultPathError> {
  return err({ kind: 'outside-vault', path: pathValue });
}

/**
 * The vault root as configured (made absolute) and as canonicalized. They differ
 * when the root itself is a symlink; a caller may name a file under either.
 */
type VaultRoots = Readonly<{
  configured: string;
  canonical: string;
}>;

/** Canonicalize the configured root, which must exist and be a directory. */
async function resolveVaultRoots(
  configuredRoot: string,
): Promise<Result<VaultRoots, VaultPathError>> {
  try {
    const canonical = await fs.realpath(configuredRoot);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      return err({
        kind: 'vault-root-unavailable',
        root: configuredRoot,
        cause: 'configured vault root is not a directory',
      });
    }
    return ok({ configured: path.resolve(configuredRoot), canonical });
  } catch (error) {
    return err({
      kind: 'vault-root-unavailable',
      root: configuredRoot,
      cause: errorMessage(error),
    });
  }
}

async function resolveExistingAbsoluteFile(
  roots: VaultRoots,
  absolutePath: string,
): Promise<Result<VaultFilePath, VaultPathError>> {
  const lexicalPath = path.resolve(absolutePath);
  const isNamedUnderConfiguredRoot = isContained(roots.configured, lexicalPath);
  const isNamedUnderCanonicalRoot = isContained(roots.canonical, lexicalPath);
  if (
    !path.isAbsolute(absolutePath) ||
    (!isNamedUnderConfiguredRoot && !isNamedUnderCanonicalRoot)
  ) {
    return outside(absolutePath);
  }

  try {
    const canonicalPath = await fs.realpath(lexicalPath);
    if (!isContained(roots.canonical, canonicalPath)) return outside(absolutePath);
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) return err({ kind: 'not-a-file', path: absolutePath });
    return ok(canonicalPath as VaultFilePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return err({ kind: 'not-found', path: absolutePath });
    return err({ kind: 'filesystem-error', path: absolutePath, cause: errorMessage(error) });
  }
}

async function resolveExistingFile(
  roots: VaultRoots,
  relativePath: VaultRelativePath,
): Promise<Result<VaultFilePath, VaultPathError>> {
  const lexicalPath = path.resolve(roots.canonical, relativePath);
  if (!isContained(roots.canonical, lexicalPath)) return outside(relativePath);
  return resolveExistingAbsoluteFile(roots, lexicalPath);
}

/**
 * Why a write-path probe whose realpath failed cannot be walked past, or null
 * when it is simply missing and its parent should be probed next.
 */
async function unwalkableProbe(
  canonicalRoot: string,
  probe: string,
  realpathError: unknown,
  relativePath: VaultRelativePath,
): Promise<Result<never, VaultPathError> | null> {
  if (errorCode(realpathError) !== 'ENOENT') {
    return err({
      kind: 'filesystem-error',
      path: relativePath,
      cause: errorMessage(realpathError),
    });
  }
  // realpath also reports ENOENT for a broken final symlink. Treating it
  // as an ordinary missing file would let writeFile follow that symlink
  // and create its target outside the vault.
  try {
    const stat = await fs.lstat(probe);
    if (stat.isSymbolicLink()) return outside(relativePath);
  } catch (lstatError) {
    if (errorCode(lstatError) !== 'ENOENT') {
      return err({ kind: 'filesystem-error', path: relativePath, cause: errorMessage(lstatError) });
    }
  }
  if (probe === canonicalRoot) {
    return err({ kind: 'filesystem-error', path: relativePath, cause: 'vault root disappeared' });
  }
  return null;
}

async function resolveFileForWrite(
  roots: VaultRoots,
  relativePath: VaultRelativePath,
): Promise<Result<VaultFilePath, VaultPathError>> {
  const canonicalRoot = roots.canonical;
  const lexicalPath = path.resolve(canonicalRoot, relativePath);
  if (!isContained(canonicalRoot, lexicalPath)) return outside(relativePath);

  // The target may not exist. Canonicalize its deepest existing ancestor,
  // then re-attach only the missing suffix. This detects an escaping symlink
  // in any existing parent without requiring the destination file to exist.
  const missingSegments: string[] = [];
  let probe = lexicalPath;
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(probe);
      if (!isContained(canonicalRoot, canonicalAncestor)) return outside(relativePath);
      const canonicalTarget = path.resolve(canonicalAncestor, ...missingSegments);
      if (!isContained(canonicalRoot, canonicalTarget)) return outside(relativePath);
      return ok(canonicalTarget as VaultFilePath);
    } catch (error) {
      const refusal = await unwalkableProbe(canonicalRoot, probe, error, relativePath);
      if (refusal !== null) return refusal;
      missingSegments.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
}

/**
 * Resolve a configured vault root once, then expose only containment-checking
 * path operations. The canonical root may differ from the configured path when
 * the root itself is a symlink.
 */
export async function createVaultWorkspace(
  configuredRoot: string,
): Promise<Result<VaultWorkspace, VaultPathError>> {
  const resolved = await resolveVaultRoots(configuredRoot);
  if (!resolved.ok) return resolved;
  const roots = resolved.value;

  return ok({
    root: roots.canonical,
    resolveExistingFile: (relativePath) => resolveExistingFile(roots, relativePath),
    resolveFileForWrite: (relativePath) => resolveFileForWrite(roots, relativePath),
    resolveExistingAbsoluteFile: (absolutePath) => resolveExistingAbsoluteFile(roots, absolutePath),
  });
}

export function formatVaultPathError(error: VaultPathError): string {
  switch (error.kind) {
    case 'vault-root-unavailable':
      return `Vault root unavailable at "${error.root}": ${error.cause}`;
    case 'not-found':
      return `Vault file not found: ${error.path}`;
    case 'not-a-file':
      return `Vault path is not a file: ${error.path}`;
    case 'outside-vault':
      return `Vault path escapes the configured root: ${error.path}`;
    case 'filesystem-error':
      return `Vault path resolution failed for "${error.path}": ${error.cause}`;
    default:
      return assertNever(error);
  }
}
