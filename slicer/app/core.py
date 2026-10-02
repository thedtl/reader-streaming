import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_MAX_SOURCE_BYTES = 550 * 1024 * 1024
DEFAULT_QPDF_TIMEOUT_SECONDS = 420
DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_SECONDS = 300
DOWNLOAD_CHUNK_BYTES = 1024 * 1024


class SlicerError(Exception):
    def __init__(self, status_code: int, public_message: str):
        super().__init__(public_message)
        self.status_code = status_code
        self.public_message = public_message


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise SlicerError(500, f"{name} must be an integer") from exc
    if parsed < 1:
        raise SlicerError(500, f"{name} must be positive")
    return parsed


def max_source_bytes() -> int:
    return env_int("MAX_SOURCE_BYTES", DEFAULT_MAX_SOURCE_BYTES)


def qpdf_timeout_seconds() -> int:
    return env_int("QPDF_TIMEOUT_SECONDS", DEFAULT_QPDF_TIMEOUT_SECONDS)


def source_download_timeout_seconds() -> int:
    return env_int("SOURCE_DOWNLOAD_TIMEOUT_SECONDS", DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_SECONDS)


def validate_page_range(start_page: int, end_page: int) -> tuple[int, int]:
    if not isinstance(start_page, int) or start_page < 1:
        raise SlicerError(400, "start_page must be a positive integer")
    if not isinstance(end_page, int) or end_page < 1:
        raise SlicerError(400, "end_page must be a positive integer")
    if end_page < start_page:
        raise SlicerError(400, "end_page must be greater than or equal to start_page")
    return start_page, end_page


def validate_source_url(source_url: str, allow_insecure_localhost: bool = False) -> str:
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme == "https":
        return source_url
    if allow_insecure_localhost and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}:
        return source_url
    raise SlicerError(400, "source_url must be an HTTPS URL")


def download_source_pdf(
    source_url: str,
    destination_path: Path,
    *,
    shared_secret: str | None = None,
    max_bytes: int | None = None,
    allow_insecure_localhost: bool = False,
) -> int:
    source_url = validate_source_url(source_url, allow_insecure_localhost=allow_insecure_localhost)
    byte_limit = max_bytes if max_bytes is not None else max_source_bytes()
    headers = {
        "User-Agent": "dtl-chapter-slicer/1.0",
    }
    if shared_secret:
        headers["X-DTL-Slicer-Secret"] = shared_secret

    request = urllib.request.Request(source_url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=source_download_timeout_seconds()) as response:
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > byte_limit:
                raise SlicerError(413, "Source PDF is larger than the configured slicer limit")

            total_bytes = 0
            with destination_path.open("wb") as output:
                while True:
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > byte_limit:
                        raise SlicerError(413, "Source PDF is larger than the configured slicer limit")
                    output.write(chunk)
    except urllib.error.HTTPError as exc:
        raise SlicerError(502, f"Source PDF fetch failed with HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SlicerError(502, "Source PDF fetch failed") from exc

    if total_bytes <= 0:
        raise SlicerError(502, "Source PDF response was empty")
    return total_bytes


def pdf_page_count(input_path: Path) -> int:
    completed = subprocess.run(
        ["qpdf", "--show-npages", str(input_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=qpdf_timeout_seconds(),
    )
    if completed.returncode != 0:
        raise SlicerError(422, "Source PDF page count could not be read")
    try:
        return int(completed.stdout.strip())
    except ValueError as exc:
        raise SlicerError(422, "Source PDF page count was not numeric") from exc


def slice_pdf_file(
    input_path: Path,
    output_path: Path,
    start_page: int,
    end_page: int,
    *,
    page_count: int | None = None,
) -> int:
    start_page, end_page = validate_page_range(start_page, end_page)
    page_count = page_count if page_count is not None else pdf_page_count(input_path)
    if end_page > page_count:
        raise SlicerError(416, "Requested page range is outside the source PDF")

    completed = subprocess.run(
        [
            "qpdf",
            "--empty",
            "--pages",
            str(input_path),
            f"{start_page}-{end_page}",
            "--",
            str(output_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=qpdf_timeout_seconds(),
    )
    if completed.returncode != 0:
        raise SlicerError(422, "qpdf could not extract the requested chapter pages")

    output_bytes = output_path.stat().st_size if output_path.exists() else 0
    if output_bytes <= 0:
        raise SlicerError(422, "qpdf did not produce a chapter PDF")
    return output_bytes
