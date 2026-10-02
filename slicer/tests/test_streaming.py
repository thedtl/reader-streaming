import asyncio
import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import main


class StreamingResponseTests(unittest.IsolatedAsyncioTestCase):
    async def prepare_response(self, size=3 * main.RESPONSE_CHUNK_BYTES):
        temp_dir = tempfile.mkdtemp(prefix="dtl-streaming-test-")
        self.addCleanup(shutil.rmtree, temp_dir, ignore_errors=True)
        output_path = Path(temp_dir) / "chapter.pdf"
        expected = hashlib.sha256()
        block = bytes(range(256)) * 256
        with output_path.open("wb") as output:
            remaining = size
            while remaining:
                chunk = block[:min(len(block), remaining)]
                output.write(chunk)
                expected.update(chunk)
                remaining -= len(chunk)
        (Path(temp_dir) / "source.pdf").write_bytes(b"synthetic source")
        with (
            patch.dict(os.environ, {"SLICER_SHARED_SECRET": "test-secret"}),
            patch.object(main.tempfile, "mkdtemp", return_value=temp_dir),
            patch.object(main, "download_source_pdf", return_value=size),
            patch.object(main, "pdf_page_count", return_value=40),
            patch.object(main, "slice_pdf_file", return_value=size) as extract,
        ):
            response = await main.slice_chapter(
                main.SlicePayload(source_url="https://example.test/source", start_page=3, end_page=8),
                "test-secret",
            )
            extract.assert_called_once_with(
                Path(temp_dir) / "source.pdf", output_path, 3, 8, page_count=40,
            )
        return response, Path(temp_dir), expected.hexdigest()

    async def wait_for_disconnect(self):
        await asyncio.Event().wait()

    async def test_large_response_has_no_length_and_preserves_every_byte(self):
        size = 33 * 1024 * 1024 + 137
        response, temp_dir, expected_digest = await self.prepare_response(size)
        digest = hashlib.sha256()
        total = 0
        body_messages = 0
        complete = False

        async def send(message):
            nonlocal total, body_messages, complete
            if message["type"] == "http.response.start":
                headers = dict(message["headers"])
                self.assertEqual(message["status"], 200)
                self.assertNotIn(b"content-length", headers)
                self.assertEqual(headers[b"content-type"], b"application/pdf")
                self.assertEqual(headers[b"content-disposition"], b'attachment; filename="chapter.pdf"')
                self.assertEqual(headers[b"cache-control"], b"private, no-store")
                self.assertEqual(headers[b"x-dtl-chapter-pages"], b"3-8")
            else:
                body = message["body"]
                self.assertLessEqual(len(body), main.RESPONSE_CHUNK_BYTES)
                digest.update(body)
                total += len(body)
                body_messages += 1
                complete = not message["more_body"]

        await response({"type": "http", "asgi": {"spec_version": "2.3"}}, self.wait_for_disconnect, send)
        self.assertEqual(total, size)
        self.assertEqual(digest.hexdigest(), expected_digest)
        self.assertGreater(body_messages, 512)
        self.assertTrue(complete)
        self.assertFalse(temp_dir.exists())

    async def test_send_failure_removes_temporary_files(self):
        response, temp_dir, _ = await self.prepare_response()

        async def send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("response send failed")

        with self.assertRaises((RuntimeError, BaseExceptionGroup)):
            await response({"type": "http", "asgi": {"spec_version": "2.3"}}, self.wait_for_disconnect, send)
        self.assertFalse(temp_dir.exists())

    async def test_client_disconnect_removes_temporary_files(self):
        response, temp_dir, _ = await self.prepare_response()
        first_chunk = asyncio.Event()

        async def receive():
            await first_chunk.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                first_chunk.set()
                await asyncio.Event().wait()

        await asyncio.wait_for(response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send), 2)
        self.assertFalse(temp_dir.exists())

    async def test_cancelled_response_removes_temporary_files(self):
        response, temp_dir, _ = await self.prepare_response()
        first_chunk = asyncio.Event()

        async def send(message):
            if message["type"] == "http.response.body":
                first_chunk.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(response(
            {"type": "http", "asgi": {"spec_version": "2.3"}}, self.wait_for_disconnect, send,
        ))
        try:
            await asyncio.wait_for(first_chunk.wait(), 2)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse(temp_dir.exists())


if __name__ == "__main__":
    unittest.main()
