# DTL Chapter Slicer

Cloud Run service for extracting chapter-only PDFs from large Dropbox source PDFs.

The Cloudflare Worker remains the public front door. It validates the patron token
and reader session, creates a short-lived internal source URL, and calls this
service with `X-DTL-Slicer-Secret`. This service downloads the source PDF through
that internal Worker URL, writes only temporary per-request files, extracts the
requested page range with `qpdf`, returns the chapter-only PDF, and deletes the
temporary directory after the response, including failed or cancelled sends.
The response streams 64 KiB chunks without `Content-Length`, allowing Uvicorn to
use HTTP/1.1 chunked transfer instead of Cloud Run's size-limited buffered response.
The Worker must forward the response body as a stream without adding a length.

Required environment:

- `SLICER_SHARED_SECRET`: shared secret also configured on the Worker.

Optional environment:

- `MAX_SOURCE_BYTES`: maximum source PDF size. Defaults to 550 MiB.
- `QPDF_TIMEOUT_SECONDS`: maximum `qpdf` runtime. Defaults to 420 seconds.
- `SOURCE_DOWNLOAD_TIMEOUT_SECONDS`: per-socket source download timeout. Defaults
  to 300 seconds.

Endpoints:

- `GET /health`
- `POST /slice`

`POST /slice` body:

```json
{
  "source_url": "https://worker.example/slice/source?token=...",
  "start_page": 123,
  "end_page": 145,
  "title": "Chapter title"
}
```

Security notes:

- The browser never calls this service directly.
- The browser never receives the source PDF.
- No persistent cache is used.
- Logs must not include source URLs, tokens, or secret values.

Local transport tests use synthetic bytes (including a response above 32 MiB),
without downloading or processing a book. From the repository root, with the
slicer requirements installed:

```sh
PYTHONPATH=slicer python -m unittest discover -s slicer/tests -v
```
