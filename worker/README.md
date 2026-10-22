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

## Citation metadata

Released 2026-10-22: the same metadata request explicitly preserves
compound surnames and historical/locative names instead of assuming the final
word is a surname. Removed fallback surname inversion and two older repairs
that deleted `and/&` to join initials/names; malformed returned names now remain
for staff correction, not silent repair. Up to four bounded warnings reach the
existing response note. Current-volume cataloging may corroborate series/volume
(including letters), not override title-page identity or turn classification
numbers into volumes. Model, image coverage, request count and bindings are
unchanged. All 38 focused metadata tests pass with mocked inference; fresh
reading accuracy and latency remain unmeasured. Source `90ce3bc` deployed as
`85fb013d-0e71-43fb-b0b3-379899a00728` at 100%; runtime/binding metadata match
the prior version. All 46 Worker and 34 generator tests pass; health/auth/CORS
pass. Generator source `dc96446` is published and byte-matches the tested page.
Packaging reused installed Wrangler 4.103.0 and bundled pdf-lib 1.17.1 without
installing packages. No fresh AI scan, PDF access or original-service change.

Released 2026-10-14: the existing read requests consistent Chicago volume/edition
abbreviations, retaining observed letter suffixes and meaningful edition qualifiers.
Numbered series and multi-volume works remain distinct; missing details are omitted.
Exact visible evidence is unchanged. Prompt tests do not prove model adherence.
Source `a7c88be`, deployed version `6a44742e-aa81-4ee5-abdc-5c99d1d101c0` at 100%.
All 40 Worker and 27 generator checks pass; health/auth/CORS pass. Nonsecret
binding metadata, secret binding names, handlers and runtime match the prior
version. The generator's published source `b68b45e` matches the tested page.
No new model call, PDF access, credential change or ToC-service update.

Commentary roles (released 2026-10-14): a scholar credited
with a commentary's introduction, translation and notes is cited as its author,
not automatically as translator. The supplied Esther title page supports
`Moore, Carey A. Esther. The Anchor Bible.` No volume is inferred or missing-volume
notice added. Preserve the complete credit as evidence. Genuine translated
editions retain separately observed author/translator roles; the same phrase
does not make every annotated translation a commentary. This clarification uses
the existing scan, with no added pages or AI calls. Mocked tests verify the
instruction and formatting handoff, not fresh model accuracy.

Worker source `66bde7b` was deployed as `87e3900b-521e-4a17-96b9-30e3b5bb08b1`
at 100%; streaming generator source `c933331` is published. All 66 offline checks
pass. Served UI bytes match and its actual formatter preserves the Moore example;
health, authentication rejection (401) and Pages CORS pass. The first live check
incorrectly expected 403 instead of the existing 401; corrected the check only.
Runtime settings and binding names match the previous version. No new AI scan,
PDF download, stable-service change or storage change; temporary dependency link
removed without an install. Original reader/generator and ToC services untouched.

The existing scan distinguishes an original collected-work author, volume
editors, and general/series editors. Preserve the volume-specific title, number
and title date span; role formatting must not promote an editor over an author.
Only explicit page locators such as `(Page 4)` are stripped, not title years.
These changes add no pages or model calls. Mocked regression tests check prompt
delivery and citation assembly, not fresh model-reading accuracy.

2026-10-08 correction: the God Who Creates scan contains hidden
OCR such as `P. BBovx`, while PDF 3 visibly credits William P. Brown and
S. Dean McBride Jr. PDF 4 dates this book to 2000; 1989 belongs to the quoted
NRSV. A bounded replay of the exposed OCR lines reproduced the reported wrong
name/title/date through the heuristic fallback. The original API response was
not retained, so the reason that run fell back is not established.

Remove the Worker and browser text-layer citation builders and their overrides
of image readings. The previous overrides addressed real contributor/title
mistakes, but unreliable OCR cannot repair them: missing supported core fields
or an edition-only title now needs manual review. Read complete visible title,
credit and publication blocks in the existing single call, for every script.
Failed/incomplete scans leave metadata editable and chapter links available;
they never appear as successful invented citations. No model or page-count change.
All 40 Worker and 20 generator checks pass with mocked inference. The initial
full-suite attempt lacked local pdf-lib; the rerun used the already bundled
matching 1.17.1 package without installing anything. Fresh AI accuracy is untested.

Released 2026-10-08: Worker source `d83d61a`, version
`ea580e80-5096-4528-8790-9e70da8b8a4a` at 100%; generator `db85cde`.
All 60 offline checks pass. Published generator bytes match the tested source;
live health, authentication rejection and Pages CORS checks pass. Wrangler
4.103.0 matches the project pin; packaging reused bundled pdf-lib 1.17.1 through
a temporary dependency symlink, without an install or lockfile change.
Runtime variables, secret binding names and compatibility date are unchanged.
No fresh AI scan, PDF download, storage change or stable-service change ran.
Existing citations/manual edits are not rewritten; rescan or edit them explicitly.

Released 2026-10-06: Worker source `4238114`, deployed version
`f27d5cd7-8833-45d8-bf81-8be91fc47f0f` at 100%; generator `ba27d15`.
All 28 Worker and 13 generator checks pass. Published generator bytes match the
tested source; its live form preserves the reported Wesley title and initials.
Health, authentication rejection and Pages CORS pass. Existing variables,
secret bindings and compatibility date are unchanged. No fresh AI scan ran;
original reader/ToC services, PDF delivery and existing files are unchanged.

## Chapter PDF filenames

Removed in this release at the user's request: metadata extraction no longer requests or
returns a multi-volume chapter-filename label. Actual volume information remains
in citations. This does not change the ToC Creator's full bookmarked-PDF filenames.
Existing optional signed `fn` values and filename headers remain supported so
previously generated links keep working. Download permissions and ranges are unchanged.

Released 2026-10-07: Worker source `8cd177f`, version
`262bc981-3ddf-4a33-be7c-101bbcce9634` at 100%; generator `e698c17`.
All 50 offline checks pass. Published generator bytes match the tested source;
live health, authentication rejection and filename-header CORS checks pass.
Variables, secret binding names and runtime compatibility date are unchanged.
No fresh AI scan or patron download was run; old links and services are unchanged.

## Local check

Title italics update (2026-10-22): `/suggest-heading` also returns `title`, using
the separately supported title already present in the existing AI response.
No prompt, schema, model, provider call count or citation-heading change. Missing,
unsupported or non-string titles and unavailable headings return an empty title.
The generator requires an exact unambiguous match or an explicit manual selection;
it must not derive italics from name punctuation. All 49 Worker tests pass.

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
