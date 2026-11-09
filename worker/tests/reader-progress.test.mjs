import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../../web/viewer.html", import.meta.url), "utf8");
const pdf = await readFile(new URL("../../build/pdf.mjs", import.meta.url), "utf8");
function between(source, start, end) {
  assert.ok(source.indexOf(start) >= 0 && source.indexOf(end) > source.indexOf(start));
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const transport = between(pdf, "function getResponseOrigin(", "function extractFilenameFromHeader(") +
  between(pdf, "function createFetchOptions(", "class PDFFetchStream {") +
  between(pdf, "class PDFFetchStreamReader {", "class PDFFetchStreamRangeReader {");
const overlay = between(html, "  // DTL palette", "  // Clear stale sessionStorage");

function harness(headers = {}, chunks = [420, 579, 1], disableStream = false) {
  let now = 1000, fetches = 0, nextTimer = 0;
  const timers = new Map(), events = new Map(), elements = new Map();
  for (const id of ["dtl-gesture-gate", "dtl-gate-title", "dtl-gate-card", "dtl-gate-message",
    "dtl-start-reading", "dtl-gate-note", "dtl-gate-firefox-note", "dtl-gate-slow-hint"]) {
    elements.set(id, { textContent: "", style: {}, setAttribute() {},
      querySelector: selector => elements.get(selector.slice(1)),
      remove() { this.removed = true; } });
  }
  const context = vm.createContext({
    Headers, AbortController, Uint8Array, ArrayBuffer, Promise,
    Date: { now: () => now },
    document: { getElementById: id => elements.get(id) },
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++nextTimer; }, clearInterval() {},
    PDFViewerApplication: { eventBus: { on: (name, fn) => events.set(name, fn) } },
    extractFilenameFromHeader: () => null,
    validateResponseStatus: status => status === 200,
    getResponseOrigin: () => "https://streaming.example",
    URL, warn: message => assert.fail(message),
    fetch: async () => {
      fetches++;
      let index = 0;
      return { status: 200, url: "https://streaming.example/chapter", headers: new Headers(headers),
        body: { getReader: () => ({
          read: async () => index < chunks.length
            ? { done: false, value: new Uint8Array(chunks[index++]) } : { done: true },
        }) } };
    },
  });
  context.window = context;
  vm.runInContext(overlay + transport + "\nglobalThis.Reader = PDFFetchStreamReader;", context);
  context.DTL_showPreparingChapter();
  const reader = new context.Reader({ source: { url: "https://streaming.example/chapter",
    rangeChunkSize: 65536, disableStream }, headers: new Headers(), isHttp: true });
  return { context, reader, elements, events, timers,
    title: () => elements.get("dtl-gate-title").textContent,
    fetches: () => fetches, advance: () => { now += 1000; } };
}

for (const [name, headers] of [
  ["streaming size header", { "X-DTL-Chapter-Bytes": "1000" }],
  ["ordinary Content-Length", { "Content-Length": "1000" }],
]) {
  test(`${name}: real chunks update the existing overlay without early 100%`, async () => {
    const h = harness(headers);
    assert.match(h.title(), /^Preparing your chapter/);
    assert.doesNotMatch(h.title(), /%/);
    await h.reader.read();
    assert.equal(h.title(), "Preparing your chapter… 42%");
    await h.reader.read();
    assert.equal(h.title(), "Preparing your chapter… 99%");
    await h.reader.read();
    assert.equal(h.title(), "Preparing your chapter… 100%");
    assert.equal((await h.reader.read()).done, true);
    assert.equal(h.fetches(), 1);
    assert.equal(h.reader.isRangeSupported, false);
    assert.equal(h.reader.contentLength, headers["Content-Length"] ? 1000 : undefined,
      "custom progress metadata must not alter parser length or HTTP range support");
  });
}

test("unknown, malformed and exceeded sizes never show invented percentages", async () => {
  for (const value of [undefined, "garbage", "-1", "0", "1.5", "9007199254740992", "1"]) {
    for (const disableStream of [false, true]) {
      const h = harness(value === undefined ? {} : { "X-DTL-Chapter-Bytes": value }, [420], disableStream);
      await h.reader.read();
      assert.equal(h.title(), "Preparing your chapter…", `${value}, disableStream=${disableStream}`);
    }
  }
});

test("readiness and error events dismiss the overlay; later chunks cannot revive it", async () => {
  for (const event of ["documentinit", "documentloaded", "pagerendered", "documenterror"]) {
    const h = harness({ "X-DTL-Chapter-Bytes": "1000" });
    await h.reader.read();
    h.context.DTL_armPreparingFinish();
    h.advance();
    h.events.get(event)();
    assert.equal(h.elements.get("dtl-gesture-gate").style.opacity, "0");
    await h.reader.read();
    assert.equal(h.title(), "Preparing your chapter… 42%");
    for (const fn of h.timers.values()) fn();
    assert.equal(h.elements.get("dtl-gesture-gate").removed, true);
  }
});
