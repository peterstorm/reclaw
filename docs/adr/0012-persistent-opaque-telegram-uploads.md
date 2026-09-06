# ADR 0012: Persist unsupported Telegram documents as opaque user uploads

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

ADR 0007 admitted only PDF and Markdown documents. Other Telegram document types were acknowledged with a rejection, so files such as `.skill` bundles could not reach Reclaw or be retained on the homelab.

The extracted-document spool is deliberately temporary and cleanup-owned by the chat activity. Reusing it for user-owned files would delete uploads after processing. Raw files also must not be interpreted, executed, unpacked, or written under attacker-controlled paths at ingress.

## Decision

Authenticated Telegram documents that are not classified as supported PDF or Markdown are accepted as **opaque stored uploads**.

- Each upload is limited to 20 MB using Telegram's declared size, HTTP `Content-Length`, and a streaming byte counter. Empty files are rejected.
- Downloads retain the existing 20-second timeout and durable Telegram acknowledgement boundary. Download, storage, and queue failures reject middleware so Telegram can redeliver the update.
- Bytes are not parsed, unpacked, scanned for an allowlisted format, or executed.
- Files are atomically written mode `0600` under `~/.local/share/reclaw/uploads/`, whose mode is forced to `0700`.
- The physical filename is generated from the stable Telegram update ID plus only a bounded ASCII extension. The untrusted original filename never becomes a path.
- A sibling `telegram-<update_id>.metadata.json` records the exact original filename, MIME claim, source, update ID, and byte count.
- `StoredUpload` is a validated value containing a safe display name, generated path, bounded MIME metadata, and byte count. `ChatJob.storedUploads` carries it through Redis to prompt construction.
- Prompt construction identifies the permanent homelab path and explicitly treats the file as untrusted data that must not be executed or followed as instructions.
- Stored uploads are excluded from `chatJobSourcePaths`; activity cleanup removes only temporary photos and extracted document text. Terminal duplicate handling therefore retains the permanent file.
- Attachment-bearing captions, including slash-command-like captions, continue to route as chat.

Supported PDF and Markdown behavior does not change: those formats continue through bounded extraction into the temporary untrusted-text spool. Contradictory supported filename/MIME claims continue to be rejected.

Stable update-derived paths make redelivery idempotent: the same immutable Telegram update repairs or replaces the same stored file and metadata rather than creating duplicate names.

## Consequences

### Positive

- `.skill`, archive, office, and other document types can be uploaded and retained for later homelab use.
- Permanent user data and temporary processing inputs have distinct ownership and cleanup semantics.
- Path traversal, executable permission, unbounded download, and automatic archive-expansion risks remain closed at ingress.
- The agent receives enough metadata to locate the file without trusting Telegram's filename as a path.

### Negative

- Stored uploads have no automatic retention policy and can consume disk until the user deletes them.
- Opaque files may require agent tools or later user action to inspect.
- A sidecar metadata write can fail after the file write; middleware then rejects and Telegram redelivery repairs the stable pair.

### Residual risk

Interactive agents run as the Reclaw Unix user with broad filesystem and Bash authority. Prompt wording is not an OS sandbox: an agent could inspect or execute a malicious upload contrary to policy. This decision prevents execution and unpacking in deterministic ingress code but does not provide malware scanning or process isolation.

## Superseded detail

This ADR supersedes ADR 0007 only where it says unsupported document formats are acknowledged with a rejection. ADR 0007's supported PDF/Markdown extraction, durable acknowledgement, redelivery, and temporary cleanup decisions remain active.
