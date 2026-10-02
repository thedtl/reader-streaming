"""Cloud-only check of the deployed reader; PDF files are temporary."""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


MAX_BYTES = 550 * 1024 * 1024
LARGE_RANGE_PAGES = 231  # Length observed in the originally failing reader token.
stage = "configuration"


class CheckFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise CheckFailure("Unexpected HTTP redirect")


opener = urllib.request.build_opener(NoRedirect())


def request(path, params=None, body=None):
    url = worker + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Origin": reader, "User-Agent": "DTL-Streaming-Smoke/1.0"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    try:
        return opener.open(urllib.request.Request(url, data=data, headers=headers), timeout=660)
    except urllib.error.HTTPError as response:
        return response


def read_json(path, params=None, body=None):
    with request(path, params, body) as response:
        require(response.status == 200, f"Expected HTTP 200; received {response.status}")
        return json.loads(response.read(1024 * 1024))


def download(response, path, source=False):
    require(response.status == 200, f"Expected PDF HTTP 200; received {response.status}")
    allowed_types = {"application/pdf", "application/octet-stream"} if source else {"application/pdf"}
    require(response.headers.get_content_type() in allowed_types, "Unexpected PDF content type")
    digest = hashlib.sha256()
    count = 0
    with path.open("wb") as output:
        while chunk := response.read(64 * 1024):
            if not count:
                require(chunk.startswith(b"%PDF-"), "Response has no PDF header")
            count += len(chunk)
            require(count <= MAX_BYTES, "PDF exceeded the existing 550 MiB source limit")
            digest.update(chunk)
            output.write(chunk)
    require(count > 0, "Empty PDF response")
    return count, digest.hexdigest()


def qpdf(*args):
    result = subprocess.run(["qpdf", *map(str, args)], capture_output=True, timeout=120)
    require(result.returncode == 0, "qpdf validation or metadata command failed")
    return result.stdout


def outline_starts(rows):
    starts = []
    for row in rows:
        if re.match(r"^\s*(?:chapter\s*)?(?:16|xvi)(?:\s*[:.\-]\s*|\s+|$)", row.get("title", ""), re.I):
            page = row.get("destpageposfrom1")
            if isinstance(page, int) and page > 0:
                starts.append(page)
        starts.extend(outline_starts(row.get("kids", [])))
    return starts


def main():
    global stage, worker, reader
    worker = os.environ["WORKER_ORIGIN"].rstrip("/")
    reader = os.environ.get("READER_ORIGIN", "https://thedtl.github.io")
    password = os.environ["STAFF_PASSWORD"]
    source_ref = os.environ["SOURCE_REF"].strip()
    require(worker == "https://dtl-chapter-reader-streaming.reference-dfe.workers.dev", "Wrong Worker target")
    require(bool(password and source_ref), "Missing staff password or source reference")
    results = []

    with tempfile.TemporaryDirectory(prefix="dtl-cloud-reader-check-") as temp_dir:
        source_path = Path(temp_dir) / "source.pdf"
        stage = "staff source and outline"
        print(json.dumps({"stage": stage}), flush=True)
        with request("/analyze", {"password": password, "dropbox": source_ref}) as response:
            source_bytes, _ = download(response, source_path, source=True)
        source_pages = int(qpdf("--show-npages", source_path))
        outlines = json.loads(qpdf("--json", "--json-key=outlines", source_path))
        starts = outline_starts(outlines.get("outlines", []))
        if len(starts) == 1 and starts[0] + LARGE_RANGE_PAGES - 1 <= source_pages:
            large_start = starts[0]
            basis = "saved chapter-16 outline start and observed 231-page token length"
        else:
            large_start = 1
            basis = "explicit pages 1-231; transport-only, no chapter identity claim"
        large_end = large_start + LARGE_RANGE_PAGES - 1
        require(source_pages > LARGE_RANGE_PAGES, "Source must exceed the restricted test range")
        print(json.dumps({"source_pages": source_pages, "source_bytes": source_bytes,
                          "large_range": [large_start, large_end], "range_basis": basis}), flush=True)

        stage = "staff signing"
        signed = read_json("/batch-sign", body={
            "password": password, "dropbox": source_ref, "mode": "pdf", "expires": 30,
            "chapters": [{"start": 1, "end": 1, "title": "One-page transport control"},
                         {"start": large_start, "end": large_end, "title": "Large transport check"}],
        })["tokens"]
        require(len(signed) == 2, "Expected two signed test ranges")

        stage = "authorization rejections"
        for label, params in [("invalid token", {"token": "invalid.token"}),
                              ("missing session", {"token": signed[0]["token"]})]:
            with request("/", params) as response:
                require(response.status == 401, f"{label} was not rejected with HTTP 401")
                require(response.headers.get_content_type() != "application/pdf", "Rejected request exposed a PDF")
        print(json.dumps({"authorization_rejections": "passed"}), flush=True)

        for entry, start, end, label in [(signed[0], 1, 1, "one-page control"),
                                        (signed[1], large_start, large_end, "large range")]:
            stage = label
            print(json.dumps({"stage": stage}), flush=True)
            began = time.monotonic()
            token = entry["token"]
            session = read_json("/reader-session", {"token": token})
            require(session["delivery"]["extraction"] == "cloud-run-slicer", "Did not select the Cloud Run slicer")
            output = Path(temp_dir) / "restricted.pdf"
            with request("/", {"token": token, "session": session["session"]}) as response:
                headers = response.headers
                require(headers.get("content-length") is None, "Response unexpectedly has Content-Length")
                for name, expected in {
                    "x-dtl-restriction-mode": "chapter-only-pdf",
                    "x-dtl-reader-session": "required",
                    "x-dtl-slicer-mode": "qpdf",
                    "x-dtl-source-pages": str(source_pages),
                    "x-dtl-chapter-pages": f"{start}-{end}",
                    "x-dtl-chapter-page-count": str(end - start + 1),
                }.items():
                    require(headers.get(name) == expected, f"Unexpected {name} header")
                output_bytes, digest = download(response, output)
            qpdf("--check", output)
            output_pages = int(qpdf("--show-npages", output))
            require(output_pages == end - start + 1, "Returned PDF has the wrong restricted page count")
            require(output_pages < source_pages and output_bytes < source_bytes, "Response was not smaller than the whole source")
            if label == "large range":
                require(output_bytes > 32 * 1024 * 1024, "Large response did not exceed 32 MiB")
            results.append({"case": label, "range": [start, end], "pages": output_pages,
                            "bytes": output_bytes, "sha256": digest, "content_length": None,
                            "seconds": round(time.monotonic() - began, 2), "qpdf_check": "passed"})
            print(json.dumps(results[-1]), flush=True)
            output.unlink()
    print(json.dumps({"status": "passed", "temporary_pdfs_removed": True, "cases": len(results)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # urllib errors and subprocess output may contain private URLs or text.
        detail = str(error) if isinstance(error, CheckFailure) else type(error).__name__
        print(json.dumps({"status": "failed", "stage": stage, "detail": detail}), flush=True)
        sys.exit(1)
