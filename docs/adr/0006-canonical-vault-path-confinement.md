# ADR 0006: Canonically confine Reclaw-owned vault filesystem operations

## Status

Accepted

## Context

Reclaw accepts vault references from Telegram commands, reconstructs paths from persisted research state, and generates note paths internally. Several adapters previously joined or resolved those strings directly against a base directory.

This permitted traversal in `/podcast` and `/ask`, trusted persisted absolute hub paths during later appends, and allowed a vault symlink to redirect a read or write outside the configured root. Podcast handling also used a hard-coded personal vault path instead of `OBSIDIAN_VAULT_PATH`.

Lexical string-prefix checks are insufficient: `/vault-old/file` starts with `/vault`, and a lexically contained path may traverse an escaping symlink. Conversely, new write targets do not exist yet and therefore cannot themselves be passed to `realpath`.

## Decision

### Parsed relative paths

`src/core/vault-path.ts` defines `VaultRelativePath`. Its constructor rejects:

- Empty and absolute paths
- POSIX, Windows drive, and UNC forms
- `.` and `..` segments
- Empty segments
- Control characters
- Percent-encoded traversal/separator tokens

Backslashes are treated as separators before validation. Filesystem adapters accept only parsed paths or re-parse untrusted persisted/generated strings at their boundary.

`/ask` separately parses a generated `TopicSlug`. It accepts a leaf slug or the canonical `reclaw/research/<slug>[/_index.md]` reference and rejects arbitrary nested paths.

### Canonical workspace boundary

`src/infra/vault-workspace.ts` canonicalizes the configured root with `realpath` and exposes three operations:

1. Resolve an existing relative file.
2. Resolve a not-yet-existing relative write target.
3. Revalidate an existing absolute file from persisted state.

Containment uses `path.relative` segment semantics, not string prefixes. Existing targets are canonicalized and must be regular files inside the canonical root. New targets canonicalize their deepest existing ancestor and append only the missing suffix; this detects escaping symlink parents before write.

Symlinks resolving inside the vault remain usable. Symlinks resolving outside are rejected.

### Covered operations

The boundary is applied to:

- Podcast note lookup, recursive basename fallback, source reads, and link-back writes
- Research hub lookup for `/ask`
- `/ask` Q&A note creation and hub updates
- Structured and emergency research note writes
- Persisted research-hub media appends
- Research MOC reads and writes

Podcast workers receive the configured vault root through dependency injection; the hard-coded root is removed.

Multi-note writes preflight every target before the first write. This does not make the write set transactional, but it prevents deterministic validation failures from creating avoidable partial output.

## Consequences

### Positive

- Traversal payloads fail at parsing or queue deserialization.
- Prefix-collision and symlink escapes fail canonical containment.
- Persisted absolute paths are not trusted across process restarts.
- All Reclaw-owned vault flows use the same configured root.
- Path validity is represented in types rather than comments.
- Pure parser tests and real-filesystem symlink tests cover the boundary.

### Negative

- Previously accepted absolute podcast paths and arbitrary nested `/ask` references are rejected.
- Vault operations now perform additional `realpath` and `stat` calls.
- A missing configured vault root fails explicitly instead of allowing a derived write attempt.
- Backend callers must pass the vault root when appending to a persisted note.

### Residual risk

Canonical preflight cannot eliminate a same-user time-of-check/time-of-use race if another process swaps directories after resolution. Fully race-free confinement requires descriptor-relative operations such as `openat` with no-follow constraints or an OS sandbox. This ADR also does not restrict the broad interactive agent’s direct Bash/filesystem authority; it confines only Reclaw-owned vault adapters.
