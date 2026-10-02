import hmac
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, Header
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.core import (
    SlicerError,
    download_source_pdf,
    max_source_bytes,
    pdf_page_count,
    slice_pdf_file,
    validate_page_range,
)


logger = logging.getLogger("dtl_chapter_slicer")
app = FastAPI(title="DTL Chapter Slicer")
RESPONSE_CHUNK_BYTES = 64 * 1024


class SlicePayload(BaseModel):
    source_url: str
    start_page: int
    end_page: int
    title: str | None = None


def no_store_headers() -> dict[str, str]:
    return {
        "cache-control": "private, no-store",
        "pragma": "no-cache",
    }


def cleanup_temp_dir(temp_dir: str) -> None:
    shutil.rmtree(temp_dir, ignore_errors=True)


class ChapterPDFResponse(StreamingResponse):
    def __init__(self, output_path: Path, temp_dir: str, headers: dict[str, str]):
        self.temp_dir = temp_dir

        async def chunks():
            with output_path.open("rb") as source:
                while chunk := await run_in_threadpool(source.read, RESPONSE_CHUNK_BYTES):
                    yield chunk

        # No Content-Length: Uvicorn sends this as an HTTP/1.1 chunked response.
        super().__init__(chunks(), media_type="application/pdf", headers=headers)

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                cleanup_temp_dir(self.temp_dir)


def require_slicer_secret(provided: str | None) -> str:
    expected = os.getenv("SLICER_SHARED_SECRET")
    if not expected:
        raise SlicerError(500, "SLICER_SHARED_SECRET is not configured")
    if not provided or not hmac.compare_digest(provided, expected):
        raise SlicerError(401, "Unauthorized")
    return expected


@app.exception_handler(SlicerError)
async def slicer_error_handler(_, exc: SlicerError):
    return JSONResponse(
        {"error": exc.public_message},
        status_code=exc.status_code,
        headers=no_store_headers(),
    )


@app.get("/health")
async def health():
    return {"ok": True, "service": "dtl-chapter-slicer"}


@app.post("/slice")
async def slice_chapter(
    payload: SlicePayload,
    x_dtl_slicer_secret: str | None = Header(default=None, alias="X-DTL-Slicer-Secret"),
):
    secret = require_slicer_secret(x_dtl_slicer_secret)
    start_page, end_page = validate_page_range(payload.start_page, payload.end_page)
    started = time.monotonic()

    temp_dir = tempfile.mkdtemp(prefix="dtl-chapter-slice-")
    source_path = Path(temp_dir) / "source.pdf"
    output_path = Path(temp_dir) / "chapter.pdf"

    try:
        source_bytes = download_source_pdf(
            payload.source_url,
            source_path,
            shared_secret=secret,
            max_bytes=max_source_bytes(),
        )
        source_pages = pdf_page_count(source_path)
        output_bytes = slice_pdf_file(source_path, output_path, start_page, end_page, page_count=source_pages)
    except Exception:
        cleanup_temp_dir(temp_dir)
        raise

    elapsed_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "Sliced chapter PDF",
        extra={
            "start_page": start_page,
            "end_page": end_page,
            "source_bytes": source_bytes,
            "source_pages": source_pages,
            "output_bytes": output_bytes,
            "elapsed_ms": elapsed_ms,
        },
    )

    headers = no_store_headers()
    headers.update({
        "content-disposition": 'attachment; filename="chapter.pdf"',
        "x-dtl-slicer-mode": "qpdf",
        "x-dtl-source-pages": str(source_pages),
        "x-dtl-chapter-pages": f"{start_page}-{end_page}",
        "x-dtl-chapter-page-count": str(end_page - start_page + 1),
        "x-dtl-slicer-ms": str(elapsed_ms),
    })

    return ChapterPDFResponse(output_path, temp_dir, headers)
