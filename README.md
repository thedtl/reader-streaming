# DTL Chapter Reader — Streaming

Separate streaming copy of the Dropbox chapter reader. The existing reader and
generator keep their current URLs and behavior.

Copied from `thedtl/reader` at
`5dbedd9fb70f73e52d3f4731e30abd8c7fc39047`; this repository starts a separate
history without changing that source repository.

- Reader: `https://thedtl.github.io/reader-streaming/web/viewer.html`
- Generator: `https://thedtl.github.io/chapter-link-generator-streaming/`
- Worker: `dtl-chapter-reader-streaming`
- Slicer: `dtl-chapter-slicer-streaming`

The copied UI and chapter restrictions are preserved. Large-book chapters are
still extracted on the server before delivery; the slicer and Worker stream
that chapter PDF without a fixed response length. Patron requests never fall
back to the entire source PDF. Faster first-page rendering remains unmeasured.

Reader browser-storage keys use a separate streaming namespace. The Worker has
no database or object-storage binding; the slicer keeps its temporary file
lifecycle. PDF.js source maps remain the original snapshot: only storage-key
literals were changed in `web/viewer.mjs`, without rebuilding PDF.js.

See `worker/README.md` and `slicer/README.md` for configuration and local checks.
Do not deploy this copy over the existing lab services.

## Release check — 2026-10-02

The published generator, reader, Worker and Cloud Run slicer are separate copies.
The existing reader/generator repository heads, original Worker deployment and
original slicer specification/traffic were verified unchanged. Stable ToC still
routes 100% to `toc-service-staff-pass-v5`.

A cloud-only test used the supplied 329,788,466-byte Psychopathology PDF:
- One-page control: 166,019 bytes, valid PDF, 15.27 seconds.
- Saved Chapter 16 start at PDF 602 plus the prior link's 231-page span: PDF
  602–832, 92,050,306 bytes, valid 231-page PDF, 38.45 seconds.
- Both responses omit Content-Length and contain only their signed page ranges.
  Missing sessions and invalid tokens were rejected. This verifies transport,
  not the scholarly correctness of the selected chapter's end or browser latency.

All 26 Worker checks and seven slicer checks pass; the generator retains its
seven range checks. The initial integration test wrongly required Dropbox's
source response to say application/pdf; it returned valid PDF bytes as
application/octet-stream. Only the test was corrected; the second run passed.
The reusable cloud-only check is `slicer/integration/check_reader.py`.

PDFs exist only in temporary cloud files and are removed afterward. Build source
uses the experimental bucket's `builds/streaming-reader/` prefix. There is no new
persistent PDF store; no stable storage or old PDF/link is modified. The new
slicer uses request-based billing and zero minimum instances.

Wrangler is pinned for reproducible deployment. Its installed development-only
dependency tree reported four high-severity audit findings; no affected local
development server was exposed, and these packages are not Worker runtime code.
