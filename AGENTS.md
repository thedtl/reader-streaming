# Streaming reader copy

This repository is the separate streaming version of the existing DTL reader.
Keep its appearance, chapter ranges, session checks and access restrictions.
Only the new reader, generator, Worker and slicer may be deployed from here.
Never deploy to or reconfigure the original reader, generator, Worker, slicer,
or either ToC service. Use a codex/ feature branch for commits and builds.

No PDF or credential belongs in this repository. Dropbox originals are read-only.
Patrons receive only the authorized chapter PDF, never a full-book fallback.
Temporary PDFs belong in cloud request storage and are deleted after use.
Do not record signed URLs, tokens, passwords or secret payloads in logs or traces.
Keep browser storage keys distinct from the original reader's keys.

Changes should be narrow: this is a transport change, not a new reader framework.
