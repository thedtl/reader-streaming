# DTL Chapter Reader — Streaming Worker

This separate Worker preserves the existing reader's token and session checks
and 90-MiB source-size extraction cutoff. Larger sources use the separate
`dtl-chapter-slicer-streaming` Cloud Run service. Its chapter-only response body
passes through without buffering or copying `Content-Length`; slicer failure
never falls back to the original full PDF.

It keeps Dropbox credentials out of the browser, signs chapter tokens, and
creates chapter-only PDF responses for the streaming reader. The existing lab
Worker and stable ToC service are not deployment targets. `/toc` routes return 404.

## Secrets

Set these as Worker secrets, not as committed files:

- `DROPBOX_REFRESH_TOKEN`: durable Dropbox refresh token for server-side access.
- `DROPBOX_APP_KEY`: Dropbox app key.
- `DROPBOX_APP_SECRET`: Dropbox app secret.
- `TOKEN_SECRET`: a separate long random string used to sign this copy's patron links.
- `STAFF_PASSWORD`: staff-only password for link generation routes.
- `SLICER_SHARED_SECRET`: existing slicer credential reused by the new copy;
  original secret bindings and services remain unchanged.
- `GEMINI_API_KEY`: existing citation-suggestion feature, not OCR or ToC processing.

For a quick short-lived smoke test only, `DROPBOX_ACCESS_TOKEN` can be used
instead of the three Dropbox refresh-token secrets. The refresh-token setup is
preferred because Dropbox access tokens expire.

## Variables

- `ALLOWED_ORIGINS`: allowed browser origins for CORS.
- `ALLOWED_PDF_REQUEST_ORIGINS`: origins allowed to request tokenized chapter
  PDFs. In production this should be the approved PDF.js reader origin.
- `SLICER_SERVICE_URL`: the deployed `dtl-chapter-slicer-streaming` URL.

`wrangler.jsonc` targets `dtl-chapter-reader-streaming` in account
`dfe98966f4ed213d2c127b6c7a09d214`. Workers Logs are enabled with invocation logs
disabled. Automatic traces include token-bearing request URLs, so trace sampling
is zero. Enabling trace sampling requires addressing that exposure first.

## Routes

- `GET /health`
- `GET /sign?password=...&dropbox=...&start=1&end=10&chapter=...`
- `POST /batch-sign`
- `GET /analyze?password=...&dropbox=...`
- `POST /suggest-heading`
- `GET /slice/source?token=...` is a short-lived source-PDF URL that also requires
  the slicer secret; it is not a patron route.
- `GET /reader-session?token=...` returns a short-lived reader session for the
  approved PDF.js viewer.
- `GET /?token=...` returns a temporary PDF containing only the token's page
  range. Patron PDF requests must include a valid `session=...` value.

For the first proof of concept, `dropbox` can be a Dropbox API file reference
such as `/Folder/Book.pdf` or `id:...`, or a Dropbox shared link. Shared links
require the Dropbox app permission `sharing.read`.

Do not put Dropbox API tokens or secrets in the browser-facing reader. Signed
reader tokens keep the Dropbox file reference encrypted.

Staff bookmark extraction can still use `/analyze` to let PDF.js inspect the
original bookmarked PDF. Patron links use `/?token=...`, which assembles a
chapter-only PDF before sending bytes to the browser.

To make copied URLs harder to reuse, the long-lived chapter token is not enough
to fetch PDF bytes. The PDF.js viewer first asks `/reader-session` for a
short-lived session, then PDF.js uses `/?token=...&session=...` internally.
Tokenized PDF requests must also come from an allowed reader origin. A raw Worker
URL pasted into a new tab should fail even when the token itself is valid.

For patron tokens, the original source page range is encrypted in the private
token payload. The public token range is rewritten to `1..chapter length` so the
reader works against the temporary chapter-only PDF, not the source PDF's page
numbers.

## Local check

```sh
npm ci
npm run check
npm test
```

## Deploy later

Wrangler is pinned locally at 4.103.0. Deployment and secret setup must target
the new Worker explicitly; do not deploy until its secrets are ready.

```sh
npx wrangler deploy --config wrangler.jsonc
```
