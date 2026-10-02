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
