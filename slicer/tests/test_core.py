import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from slicer.app.core import (
    SlicerError,
    download_source_pdf,
    pdf_page_count,
    slice_pdf_file,
    validate_page_range,
)


def write_test_pdf(path: Path, page_count: int) -> None:
    objects = []
    page_object_ids = []

    def add_object(body: str) -> int:
        objects.append(body)
        return len(objects)

    catalog_id = add_object("<< /Type /Catalog /Pages 2 0 R >>")
    pages_id = add_object("")
    font_id = add_object("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for page_number in range(1, page_count + 1):
        text = f"BT /F1 12 Tf 72 100 Td (Page {page_number}) Tj ET"
        content_id = add_object(f"<< /Length {len(text)} >>\nstream\n{text}\nendstream")
        page_id = add_object(
            "<< /Type /Page "
            f"/Parent {pages_id} 0 R "
            "/MediaBox [0 0 200 200] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>"
        )
        page_object_ids.append(page_id)

    objects[pages_id - 1] = (
        f"<< /Type /Pages /Count {page_count} "
        f"/Kids [{' '.join(f'{object_id} 0 R' for object_id in page_object_ids)}] >>"
    )

    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_id, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{object_id} 0 obj\n{body}\nendobj\n".encode("ascii"))

    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            "trailer\n"
            f"<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
            "startxref\n"
            f"{xref_offset}\n"
            "%%EOF\n"
        ).encode("ascii")
    )
    path.write_bytes(output)


@unittest.skipUnless(shutil.which("qpdf"), "qpdf is required for slicer core tests")
class SlicerCoreTests(unittest.TestCase):
    def test_slice_pdf_file_returns_only_requested_pages(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "source.pdf"
            output_path = Path(temp_dir) / "chapter.pdf"
            write_test_pdf(source_path, 5)

            output_bytes = slice_pdf_file(source_path, output_path, 2, 4)

            self.assertGreater(output_bytes, 0)
            self.assertEqual(pdf_page_count(output_path), 3)

    def test_validate_page_range_rejects_reversed_range(self):
        with self.assertRaises(SlicerError) as context:
            validate_page_range(5, 4)

        self.assertEqual(context.exception.status_code, 400)

    def test_download_source_pdf_sends_slicer_secret(self):
        class FakeResponse:
            def __init__(self):
                self.headers = {"content-length": "17"}
                self._chunks = [b"%PDF-1.4\n", b"% test\n", b""]

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _):
                return self._chunks.pop(0)

        captured = {}

        def fake_urlopen(request, **_):
            captured["secret"] = request.headers.get("X-dtl-slicer-secret")
            return FakeResponse()

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "download.pdf"
            with patch("slicer.app.core.urllib.request.urlopen", fake_urlopen):
                bytes_downloaded = download_source_pdf(
                    "https://worker.example/slice/source?token=test",
                    output_path,
                    shared_secret="test-secret",
                )
            file_bytes = output_path.read_bytes()

        self.assertEqual(captured["secret"], "test-secret")
        self.assertEqual(bytes_downloaded, len(file_bytes))


if __name__ == "__main__":
    unittest.main()
