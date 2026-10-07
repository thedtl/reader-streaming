import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import worker from "../src/index.js";

const base = "https://dtl-chapter-reader-streaming.example.workers.dev";
const origin = "https://thedtl.github.io";
const readerHeaders = { origin, "user-agent": "streaming-test-browser" };
const env = {
  ALLOWED_ORIGINS: origin,
  ALLOWED_PDF_REQUEST_ORIGINS: origin,
  TOKEN_SECRET: "synthetic-streaming-token-secret",
  STAFF_PASSWORD: "synthetic-staff-password",
  DROPBOX_ACCESS_TOKEN: "synthetic-dropbox-token",
  SLICER_SHARED_SECRET: "synthetic-slicer-secret",
  SLICER_SERVICE_URL: "https://streaming-slicer.example.test",
};
const sourceSize = 100 * 1024 * 1024;

function request(path, options = {}) {
  return new Request(base + path, { headers: readerHeaders, ...options });
}

function mockUpstream(t, slicerResponse) {
  const calls = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://content.dropboxapi.com/")) {
      assert.equal(new Headers(options.headers).get("range"), "bytes=0-0",
        "large sources must only be probed, never downloaded through the Worker");
      return new Response(new Uint8Array([37]), {
        status: 206, headers: { "content-range": `bytes 0-0/${sourceSize}` },
      });
    }
    assert.equal(String(url), env.SLICER_SERVICE_URL + "/slice");
    assert.equal(options.headers["X-DTL-Slicer-Secret"], env.SLICER_SHARED_SECRET);
    return slicerResponse;
  });
  return calls;
}

async function chapterToken(filename, download = false) {
  const response = await worker.fetch(request("/batch-sign", {
    method: "POST", body: JSON.stringify({ password: env.STAFF_PASSWORD,
      dropbox: "id:synthetic-book", download,
      chapters: [{ start: 8, end: 12, title: "Chapter", filename }] }),
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).tokens[0].token;
}

function tokenPayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

function assertFilename(response, filename) {
  const disposition = response.headers.get("content-disposition");
  const match = /^inline; filename="([^"\\]+)"; filename\*=UTF-8''(.+)$/.exec(disposition);
  assert.ok(match, "filename must use a safe inline disposition with ASCII and UTF-8 forms");
  assert.match(match[1], /^[\x20-\x7e]+$/);
  assert.equal(decodeURIComponent(match[2]), filename);
  assert.ok(response.headers.get("access-control-expose-headers").split(",").includes("content-disposition"));
}

async function readerSession(token, extraction = "cloud-run-slicer") {
  const response = await worker.fetch(request("/reader-session?token=" + token), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.delivery.extraction, extraction);
  return data.session;
}

test("large chapter returns the slicer's unbuffered stream without Content-Length", { timeout: 5000 }, async t => {
  let upstream;
  const body = new ReadableStream({ start(controller) { upstream = controller; } });
  const sliced = new Response(body, { headers: { "content-type": "application/pdf",
    "content-length": "99999999", "x-dtl-chapter-page-count": "5" } });
  t.mock.method(sliced, "arrayBuffer", () => { throw new Error("Do not buffer the chapter"); });
  const calls = mockUpstream(t, sliced);
  const filename = "Wesley, Works, Vol. 19 - Journál (서문).pdf";
  const token = await chapterToken(filename), session = await readerSession(token);
  const response = await worker.fetch(request(`/?token=${token}&session=${session}`), env);
  assert.equal(response.status, 200);
  assert.equal(response.body, body);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-dtl-restriction-mode"), "chapter-only-pdf");
  assert.equal(response.headers.get("x-dtl-reader-session"), "required");
  assert.equal(response.headers.get("x-dtl-chapter-page-count"), "5");
  assert.equal(response.headers.get("accept-ranges"), "none");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assertFilename(response, filename);
  assert.equal(tokenPayload(token).d, 0, "a filename does not enable downloads");
  const sent = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual([sent.start_page, sent.end_page], [8, 12]);
  assert.equal(sent.title, "Chapter", "download naming must not change the PDF title");
  assert.equal(new URL(sent.source_url).origin, base);
  assert.equal(new URL(sent.source_url).pathname, "/slice/source");
  const reader = response.body.getReader();
  upstream.enqueue(new Uint8Array([1, 2]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2]));
  upstream.enqueue(new Uint8Array([3])); upstream.close();
  assert.deepEqual((await reader.read()).value, new Uint8Array([3]));
  assert.equal((await reader.read()).done, true);
});

test("staff signing sanitizes optional filenames, bounds UTF-8 bytes, and keeps legacy tokens", async t => {
  t.mock.method(console, "error", () => {});
  const query = new URLSearchParams({ password: env.STAFF_PASSWORD,
    dropbox: "id:synthetic-book", start: "8", end: "12", chapter: "Chapter", download: "1",
    filename: ' ../Wesley\\Works: Vol. 19/"Journa\u0301l";\r\nInjected: value\u202e\ud800.PDF ' });
  const response = await worker.fetch(request("/sign?" + query), env);
  assert.equal(response.status, 200);
  const signed = await response.json(), payload = tokenPayload(signed.token);
  assert.equal(signed.payload.fn, payload.fn);
  assert.equal(payload.fn, payload.fn.normalize("NFC"));
  assert.ok(payload.fn.includes("Journál"));
  assert.doesNotMatch(payload.fn, /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/);
  assert.match(payload.fn, /\.pdf$/);
  assert.equal(payload.d, 1);
  assert.equal(payload.c, "Chapter");
  const long = tokenPayload(await chapterToken("Wesley, Works, Vol. 19 - " + "서문😀".repeat(200)));
  assert.ok(Buffer.byteLength(long.fn, "utf8") <= 240);
  assert.ok(long.fn.startsWith("Wesley, Works, Vol. 19 - "));
  assert.ok(long.fn.endsWith(".pdf"));
  assert.equal(long.fn, Buffer.from(long.fn).toString("utf8"));
  const legacy = tokenPayload(await chapterToken());
  assert.ok(!Object.hasOwn(legacy, "fn"));
  assert.equal(legacy.d, 0);
  query.set("password", "incorrect");
  assert.equal((await worker.fetch(request("/sign?" + query), env)).status, 401);
  assert.equal((await worker.fetch(request("/batch-sign", { method: "POST", body: JSON.stringify({
    password: "incorrect", dropbox: "id:synthetic-book",
    chapters: [{ start: 8, end: 12, filename: "Unauthorized.pdf" }],
  }) }), env)).status, 401);
});

test("small chapter filenames preserve PDF title, ranges, and legacy behavior", async t => {
  const source = await PDFDocument.create();
  for (let page = 1; page <= 14; page++) source.addPage([100 + page, 200]);
  const sourceBytes = await source.save();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(String(url).startsWith("https://content.dropboxapi.com/"));
    if (new Headers(options.headers).get("range")) {
      return new Response(new Uint8Array([37]), { status: 206,
        headers: { "content-range": `bytes 0-0/${sourceBytes.byteLength}` } });
    }
    return new Response(sourceBytes, { headers: { "content-length": String(sourceBytes.byteLength) } });
  });
  for (const filename of ["Wesley, Works, Vol. 19 - Journal.pdf", undefined]) {
    const token = await chapterToken(filename), session = await readerSession(token, "worker-pdf-lib");
    const response = await worker.fetch(request(`/?token=${token}&session=${session}&filename=Patron.pdf`), env);
    assert.equal(response.status, 200);
    if (filename) assertFilename(response, filename);
    else assert.equal(response.headers.get("content-disposition"), null);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    assert.equal(pdf.getTitle(), "Chapter");
    assert.deepEqual(pdf.getPages().map(page => page.getWidth()), [108, 109, 110, 111, 112]);
    assert.equal(response.headers.get("x-dtl-chapter-pages"), "8-12");
  }
});

test("legacy streaming tokens do not acquire a response filename", async t => {
  mockUpstream(t, new Response(new Uint8Array([37])));
  const token = await chapterToken(), session = await readerSession(token);
  const response = await worker.fetch(request(`/?token=${token}&session=${session}&filename=Patron.pdf`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), null);
});

test("missing, changed, or wrong-browser credentials cannot bypass chapter access", async t => {
  const calls = mockUpstream(t, null);
  const token = await chapterToken("Wesley, Works, Vol. 19 - Journal.pdf"), session = await readerSession(token);
  const tampered = Buffer.from(JSON.stringify({ ...tokenPayload(token), fn: "Changed.pdf" })).toString("base64url")
    + "." + token.split(".")[1];
  calls.length = 0;
  for (const [path, headers, status] of [
    ["/", readerHeaders, 401],
    ["/?token=" + token, readerHeaders, 401],
    [`/?token=${token}&session=invalid`, readerHeaders, 401],
    [`/?token=${token.slice(0, -2)}AA&session=${session}`, readerHeaders, 401],
    [`/?token=${tampered}&session=${session}`, readerHeaders, 401],
    [`/?token=${token}&session=${session}`, {}, 403],
    [`/?token=${token}&session=${session}`, { ...readerHeaders, "user-agent": "other-browser" }, 401],
    ["/slice/source?token=" + token, readerHeaders, 401],
  ]) {
    assert.equal((await worker.fetch(request(path, { headers }), env)).status, status);
  }
  assert.equal(calls.length, 0, "rejected patron requests must not reach Dropbox or the slicer");
});

test("slicer failure preserves failure instead of returning the full source", async t => {
  const calls = mockUpstream(t, new Response("Synthetic slicer failure", { status: 503 }));
  const token = await chapterToken(), session = await readerSession(token);
  calls.length = 0;
  const response = await worker.fetch(request(`/?token=${token}&session=${session}`), env);
  assert.equal(response.status, 502);
  assert.equal(calls.length, 2, "only one source probe and one slicer request are allowed");
  assert.match((await response.json()).error, /Chapter slicer failed/);
});

test("streaming copy cannot dispatch any ToC route to the stable service", async t => {
  const calls = mockUpstream(t, null);
  for (const route of ["health", "analyze", "metadata", "jobs", "job-status", "run-feedback", "runs/recent", "source"]) {
    for (const method of ["GET", "POST"]) {
      assert.equal((await worker.fetch(request("/toc/" + route, { method }), env)).status, 404);
    }
  }
  assert.equal(calls.length, 0);
});

test("streaming reader keeps its storage separate from the existing same-origin reader", async () => {
  const html = await readFile(new URL("../../web/viewer.html", import.meta.url), "utf8");
  const viewer = await readFile(new URL("../../web/viewer.mjs", import.meta.url), "utf8");
  assert.match(html, /"dtlStreamingTrapArmed"/);
  assert.doesNotMatch(html, /"dtlTrapArmed"/);
  for (const key of ["preferences", "history", "signature"]) {
    assert.ok(viewer.includes(`"pdfjs.streaming.${key}"`));
    assert.ok(!viewer.includes(`"pdfjs.${key}"`));
  }
});
