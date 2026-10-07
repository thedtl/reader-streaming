import { PDFDocument } from "pdf-lib";
import { handleSuggestHeading } from "./heading-suggestion.js";

const DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";
const DROPBOX_SHARED_LINK_FILE_URL = "https://content.dropboxapi.com/2/sharing/get_shared_link_file";
const DROPBOX_SHARED_LINK_METADATA_URL = "https://api.dropboxapi.com/2/sharing/get_shared_link_metadata";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const TOC_BACKEND_URL = "https://toc-service-4s2ll3m6pa-uc.a.run.app";
const READER_SESSION_TTL_SECONDS = 10 * 60;
const TOC_SOURCE_TOKEN_TTL_SECONDS = 3 * 60 * 60;
const SLICER_SOURCE_TOKEN_TTL_SECONDS = 5 * 60;
const CHAPTER_PDF_MAX_SOURCE_BYTES = 90 * 1024 * 1024;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

let cachedDropboxAccessToken = null;

// Tombstone for the former image-renderer lab Durable Object class. Cloudflare
// keeps migration history, so the class must remain exported until we choose to
// run an explicit delete-class migration.
export class PageRenderer {
  async fetch() {
    return new Response("PageRenderer is no longer used by this lab Worker.", {
      status: 410,
    });
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "dtl-chapter-reader-streaming" }, request, env);
      }

      if (url.pathname === "/sign" && request.method === "GET") {
        return await handleSign(request, env);
      }

      if (url.pathname === "/batch-sign" && request.method === "POST") {
        return await handleBatchSign(request, env);
      }

      if (url.pathname === "/analyze" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleAnalyze(request, env);
      }

      if (url.pathname === "/suggest-heading" && request.method === "POST") {
        return await handleSuggestHeading(request, env, {
          json,
          requireStaffPasswordValue,
        });
      }

      if (url.pathname === "/toc" || url.pathname.startsWith("/toc/")) {
        return json({ error: "Not found" }, request, env, 404);
      }

      if (url.pathname === "/slice/source" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleSlicerSource(request, env);
      }

      if (url.pathname === "/reader-session" && request.method === "GET") {
        return await handleReaderSession(request, env);
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return await handlePdfRequest(request, env);
      }

      return json({ error: "Method not allowed" }, request, env, 405);
    } catch (error) {
      console.error("Worker request failed", {
        method: request.method,
        path: url.pathname,
        status: error.status || 500,
        name: error.name || "Error",
        message: error.message || "Unexpected worker error",
        stack: String(error.stack || "").slice(0, 1200),
      });
      return json(
        { error: error.message || "Unexpected worker error" },
        request,
        env,
        error.status || 500,
      );
    }
  },
};

async function handleSign(request, env) {
  requireStaffPassword(request, env);

  const url = new URL(request.url);
  const payload = buildPayload({
    dropbox: url.searchParams.get("dropbox") || url.searchParams.get("path"),
    mode: url.searchParams.get("mode"),
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
    chapter: url.searchParams.get("chapter") || url.searchParams.get("c"),
    filename: url.searchParams.get("filename"),
    download: url.searchParams.get("download"),
    expires: url.searchParams.get("expires"),
  });

  const token = await signToken(payload, env);
  return json({ token, payload: publicPayload(payload) }, request, env);
}

async function handleBatchSign(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, request, env, 400);
  }

  requireStaffPasswordValue(body.password, env);

  if (!Array.isArray(body.chapters) || body.chapters.length === 0) {
    return json({ error: "chapters must be a non-empty array" }, request, env, 400);
  }

  const tokens = [];
  for (const chapter of body.chapters) {
    const payload = buildPayload({
      dropbox: body.dropbox || body.path,
      mode: body.mode,
      start: chapter.start,
      end: chapter.end,
      chapter: chapter.title || chapter.chapter || chapter.name,
      filename: chapter.filename,
      download: body.download,
      expires: body.expires,
    });
    tokens.push({
      title: payload.c,
      start: payload.s,
      end: payload.e,
      token: await signToken(payload, env),
    });
  }

  return json({ tokens }, request, env);
}

async function handleAnalyze(request, env) {
  requireStaffPassword(request, env);

  const url = new URL(request.url);
  const dropboxRef = normalizeDropboxRef(url.searchParams.get("dropbox") || url.searchParams.get("path"));
  return proxyDropboxPdf(request, env, dropboxRef);
}

async function handleTocHealth(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  return json({ ok: true, service: "toc" }, request, env);
}

async function handleTocAnalyze(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const dropboxRef = normalizeDropboxRef(dropboxRefFromBody(body));
  const sourceUrl = await buildTocSourceUrl(request, env, dropboxRef);
  const maxPages = Number.isFinite(Number(body.max_pages)) ? Number(body.max_pages) : 100;
  const skipBookmarks = body.skip_bookmarks === true || body.skip_bookmarks === "true";
  const scanFromEnd = body.scan_from_end === true || body.scan_from_end === "true";

  const form = new FormData();
  form.append("pdf_url", sourceUrl);
  form.append("max_pages", String(maxPages));
  form.append("skip_bookmarks", skipBookmarks ? "true" : "false");
  form.append("scan_from_end", scanFromEnd ? "true" : "false");

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/analyze-pdf-ai`, {
    method: "POST",
    headers: {
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
    body: form,
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocMetadata(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const dropboxRef = normalizeDropboxRef(dropboxRefFromBody(body));
  const sourceUrl = await buildTocSourceUrl(request, env, dropboxRef);
  const maxPages = Number.isFinite(Number(body.max_pages))
    ? Math.max(1, Math.min(Number(body.max_pages), 20))
    : 8;

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/toc-metadata`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
    body: JSON.stringify({
      pdf_url: sourceUrl,
      max_pages: maxPages,
    }),
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocJobStart(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const dropboxRef = normalizeDropboxRef(dropboxRefFromBody(body));
  const sourceUrl = await buildTocSourceUrl(request, env, dropboxRef);
  const maxPages = Number.isFinite(Number(body.max_pages)) ? Number(body.max_pages) : 100;
  const skipBookmarks = body.skip_bookmarks === true || body.skip_bookmarks === "true";
  const scanFromEnd = body.scan_from_end === true || body.scan_from_end === "true";

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/toc-jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
    body: JSON.stringify({
      pdf_url: sourceUrl,
      max_pages: maxPages,
      skip_bookmarks: skipBookmarks,
      scan_from_end: scanFromEnd,
    }),
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocJobStatus(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const jobId = String(body.job_id || body.jobId || "").trim();
  if (!jobId) {
    throw new HttpError(400, "Missing required parameter: job_id");
  }

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/toc-jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers: {
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocRunFeedback(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const runId = String(body.run_id || body.runId || body.job_id || body.jobId || "").trim();
  if (!runId) {
    throw new HttpError(400, "Missing required parameter: run_id");
  }

  const payload = {
    outcome: String(body.outcome || "").trim(),
    note: String(body.note || "").trim(),
    issues: Array.isArray(body.issues) ? body.issues : [],
    edited_entries: Array.isArray(body.edited_entries) ? body.edited_entries : [],
    result_summary: body.result_summary && typeof body.result_summary === "object" ? body.result_summary : {},
  };

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/toc-runs/${encodeURIComponent(runId)}/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
    body: JSON.stringify(payload),
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocRecentRuns(request, env) {
  const body = await readJsonRequest(request);
  if (!body) {
    throw new HttpError(400, "Invalid JSON body");
  }

  requireStaffPasswordValue(body.password, env);
  const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(Number(body.limit), 100)) : 20;

  const backendResponse = await fetch(`${TOC_BACKEND_URL}/toc-runs/recent?limit=${encodeURIComponent(String(limit))}`, {
    method: "GET",
    headers: {
      "X-DTL-Staff-Password": tocBackendPassword(body.password, env),
    },
  });

  return relayBackendResponse(backendResponse, request, env);
}

async function handleTocSource(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new HttpError(401, "Missing token");
  }

  const payload = await verifyToken(token, env);
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== "toc-source" || !payload.exp || payload.exp < now) {
    throw new HttpError(401, "Invalid or expired source token");
  }

  const response = await proxyDropboxPdf(request, env, payload.dbx);
  response.headers.set("x-dtl-restriction-mode", "toc-source-pdf");
  return response;
}

async function handleSlicerSource(request, env) {
  requireSlicerSecret(request, env);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new HttpError(401, "Missing token");
  }

  const payload = await verifyToken(token, env);
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== "slicer-source" || !payload.exp || payload.exp < now) {
    throw new HttpError(401, "Invalid or expired source token");
  }

  const response = await proxyDropboxPdf(request, env, payload.dbx);
  response.headers.set("x-dtl-restriction-mode", "slicer-source-pdf");
  return response;
}

async function handleReaderSession(request, env) {
  const sourceError = validatePdfRequestSource(request, env);
  if (sourceError) {
    return json({ error: sourceError }, request, env, 403);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing token" }, request, env, 401);
  }

  const payload = await verifyToken(token, env);
  requirePdfPayload(payload);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return json({ error: "Token expired" }, request, env, 401);
  }

  const delivery = await detectChapterDelivery(request, env, payload);
  const session = await signReaderSession(token, request, env);
  return json({
    session,
    expiresIn: READER_SESSION_TTL_SECONDS,
    delivery,
  }, request, env);
}

async function handlePdfRequest(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return json({ error: "Missing token" }, request, env, 401);
  }

  const sourceError = validatePdfRequestSource(request, env);
  if (sourceError) {
    return json({ error: sourceError }, request, env, 403);
  }

  const payload = await verifyToken(token, env);
  requirePdfPayload(payload);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    return json({ error: "Token expired" }, request, env, 401);
  }

  await verifyReaderSession(url.searchParams.get("session"), token, request, env);
  return proxyChapterPdf(request, env, payload);
}

async function proxyDropboxPdf(request, env, dropboxRef) {
  const accessToken = await getDropboxAccessToken(env);
  const downloadRef = await resolveDropboxRefForDownload(accessToken, dropboxRef);
  const dropboxResponse = await fetchDropboxPdf(request, accessToken, downloadRef);

  if (!dropboxResponse.ok && dropboxResponse.status !== 206 && dropboxResponse.status !== 416) {
    const details = await dropboxResponse.text().catch(() => "");
    const safeDetails = summarizeDropboxError(details);
    console.warn("Dropbox download failed", {
      status: dropboxResponse.status,
      details: safeDetails,
    });
    return json(
      {
        error: "Dropbox download failed",
        status: dropboxResponse.status,
        details: safeDetails,
        hint: dropboxErrorHint(safeDetails),
      },
      request,
      env,
      502,
    );
  }

  const headers = corsHeaders(request, env);
  copyHeader(dropboxResponse.headers, headers, "accept-ranges");
  copyHeader(dropboxResponse.headers, headers, "content-length");
  copyHeader(dropboxResponse.headers, headers, "content-range");
  copyHeader(dropboxResponse.headers, headers, "etag");
  copyHeader(dropboxResponse.headers, headers, "last-modified");
  headers.set("content-type", dropboxResponse.headers.get("content-type") || "application/pdf");
  headers.set("cache-control", "private, no-store");
  headers.set("x-dtl-restriction-mode", "full-pdf-streaming");

  const body = request.method === "HEAD" ? null : dropboxResponse.body;
  return new Response(body, {
    status: dropboxResponse.status,
    headers,
  });
}

async function proxyChapterPdf(request, env, payload) {
  const accessToken = await getDropboxAccessToken(env);
  const downloadRef = await resolveDropboxRefForDownload(accessToken, payload.dbx);
  const probedSourceLength = await probeDropboxDownloadBytes(request, accessToken, downloadRef);
  if (probedSourceLength > CHAPTER_PDF_MAX_SOURCE_BYTES) {
    console.warn("Chapter PDF source exceeds Worker extraction limit; using slicer", {
      sourceBytes: probedSourceLength,
      maxSourceBytes: CHAPTER_PDF_MAX_SOURCE_BYTES,
    });
    return proxyChapterPdfViaSlicer(request, env, payload, probedSourceLength);
  }

  const dropboxResponse = await fetchDropboxPdf(new Request(request.url), accessToken, downloadRef);

  if (!dropboxResponse.ok) {
    return dropboxErrorResponse(dropboxResponse, request, env);
  }

  const sourceLength = Number(dropboxResponse.headers.get("content-length") || 0);
  if (sourceLength > CHAPTER_PDF_MAX_SOURCE_BYTES) {
    console.warn("Chapter PDF source exceeds Worker extraction limit; using slicer", {
      sourceBytes: sourceLength,
      maxSourceBytes: CHAPTER_PDF_MAX_SOURCE_BYTES,
    });
    return proxyChapterPdfViaSlicer(request, env, payload, sourceLength);
  }

  let sourceBytes;
  try {
    sourceBytes = await dropboxResponse.arrayBuffer();
  } catch (error) {
    if (isMemoryLimitError(error)) {
      console.warn("Chapter PDF extraction hit Worker memory limit; using slicer", {
        message: error.message || "Memory limit exceeded",
      });
      return proxyChapterPdfViaSlicer(request, env, payload, sourceLength);
    }
    throw error;
  }
  const sourcePdf = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });
  const pageCount = sourcePdf.getPageCount();
  const startPage = Math.max(1, Math.min(payload.ss, pageCount));
  const endPage = Math.max(startPage, Math.min(payload.se, pageCount));
  const pageIndexes = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pageIndexes.push(page - 1);
  }

  const chapterPdf = await PDFDocument.create();
  const copiedPages = await chapterPdf.copyPages(sourcePdf, pageIndexes);
  for (const page of copiedPages) {
    chapterPdf.addPage(page);
  }
  chapterPdf.setTitle(String(payload.c || "Chapter"));
  const chapterBytes = await chapterPdf.save();

  const headers = corsHeaders(request, env);
  headers.set("content-type", "application/pdf");
  headers.set("content-length", String(chapterBytes.byteLength));
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "none");
  headers.set("x-dtl-restriction-mode", "chapter-only-pdf");
  headers.set("x-dtl-reader-session", "required");
  headers.set("x-dtl-source-pages", String(pageCount));
  headers.set("x-dtl-chapter-pages", `${startPage}-${endPage}`);
  headers.set("x-dtl-chapter-page-count", String(pageIndexes.length));
  setChapterFilename(headers, payload.fn);

  return new Response(request.method === "HEAD" ? null : chapterBytes, {
    status: 200,
    headers,
  });
}

async function proxyChapterPdfViaSlicer(request, env, payload, sourceBytes = 0) {
  requireEnv(env, "SLICER_SERVICE_URL");
  requireEnv(env, "SLICER_SHARED_SECRET");

  const sourceUrl = await buildSlicerSourceUrl(request, env, payload.dbx);
  const slicerResponse = await fetch(`${normalizedServiceUrl(env.SLICER_SERVICE_URL)}/slice`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-DTL-Slicer-Secret": env.SLICER_SHARED_SECRET,
    },
    body: JSON.stringify({
      source_url: sourceUrl,
      start_page: payload.ss,
      end_page: payload.se,
      title: payload.c || "Chapter",
    }),
  });

  if (!slicerResponse.ok) {
    const details = await slicerResponse.text().catch(() => "");
    const safeDetails = summarizeSlicerError(details);
    console.warn("Chapter slicer failed; refusing to stream source PDF", {
      status: slicerResponse.status,
      sourceBytes,
      details: safeDetails,
    });
    throw new HttpError(
      slicerResponse.status === 413 || slicerResponse.status === 416 ? slicerResponse.status : 502,
      `Chapter slicer failed: ${safeDetails || "No details"}`,
    );
  }

  const headers = corsHeaders(request, env);
  headers.set("content-type", "application/pdf");
  headers.set("cache-control", "private, no-store");
  headers.set("accept-ranges", "none");
  headers.set("x-dtl-restriction-mode", "chapter-only-pdf");
  headers.set("x-dtl-reader-session", "required");
  headers.set("x-dtl-slicer-mode", slicerResponse.headers.get("x-dtl-slicer-mode") || "cloud-run");
  copyHeader(slicerResponse.headers, headers, "x-dtl-source-pages");
  copyHeader(slicerResponse.headers, headers, "x-dtl-chapter-pages");
  copyHeader(slicerResponse.headers, headers, "x-dtl-chapter-page-count");
  copyHeader(slicerResponse.headers, headers, "x-dtl-slicer-ms");
  setChapterFilename(headers, payload.fn);

  return new Response(request.method === "HEAD" ? null : slicerResponse.body, {
    status: 200,
    headers,
  });
}

async function detectChapterDelivery(request, env, payload) {
  const delivery = {
    mode: "chapter-only-pdf",
    start: 1,
    end: payload.e,
    sourceStart: payload.ss,
    sourceEnd: payload.se,
  };

  try {
    const sourceBytes = await probeDropboxSourceBytes(request, env, payload.dbx);
    if (sourceBytes > CHAPTER_PDF_MAX_SOURCE_BYTES) {
      return {
        ...delivery,
        extraction: hasSlicerConfig(env) ? "cloud-run-slicer" : "worker-fail-closed",
        reason: "source_too_large",
        sourceBytes,
      };
    }
    return { ...delivery, extraction: "worker-pdf-lib", sourceBytes };
  } catch (error) {
    console.warn("Chapter delivery probe failed; defaulting to chapter-only PDF", {
      message: error.message || "Unknown delivery probe error",
    });
    return delivery;
  }
}

async function probeDropboxSourceBytes(request, env, dropboxRef) {
  const accessToken = await getDropboxAccessToken(env);
  const downloadRef = await resolveDropboxRefForDownload(accessToken, dropboxRef);
  return probeDropboxDownloadBytes(request, accessToken, downloadRef);
}

async function probeDropboxDownloadBytes(request, accessToken, downloadRef) {
  const headers = new Headers();
  headers.set("range", "bytes=0-0");
  const probeRequest = new Request(request.url, {
    method: "GET",
    headers,
  });
  const response = await fetchDropboxPdf(probeRequest, accessToken, downloadRef);
  if (!response.ok && response.status !== 206 && response.status !== 416) {
    return 0;
  }
  return totalBytesFromContentRange(response.headers.get("content-range"))
    || Number(response.headers.get("content-length") || 0);
}

function totalBytesFromContentRange(value) {
  const match = String(value || "").match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function isMemoryLimitError(error) {
  return String(error?.message || "").toLowerCase().includes("memory limit");
}

async function buildTocSourceUrl(request, env, dropboxRef) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({
    v: 1,
    typ: "toc-source",
    dbx: dropboxRef,
    ss: 1,
    se: 999999,
    s: 1,
    e: 999999,
    d: 0,
    c: "ToC source PDF",
    iat: now,
    exp: now + TOC_SOURCE_TOKEN_TTL_SECONDS,
  }, env);

  const sourceUrl = new URL(request.url);
  sourceUrl.pathname = "/toc/source";
  sourceUrl.search = "";
  sourceUrl.searchParams.set("token", token);
  return sourceUrl.toString();
}

async function buildSlicerSourceUrl(request, env, dropboxRef) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({
    v: 1,
    typ: "slicer-source",
    dbx: dropboxRef,
    ss: 1,
    se: 999999,
    s: 1,
    e: 999999,
    d: 0,
    c: "Slicer source PDF",
    iat: now,
    exp: now + SLICER_SOURCE_TOKEN_TTL_SECONDS,
  }, env);

  const sourceUrl = new URL(request.url);
  sourceUrl.pathname = "/slice/source";
  sourceUrl.search = "";
  sourceUrl.searchParams.set("token", token);
  return sourceUrl.toString();
}

async function fetchDropboxPdf(request, accessToken, dropboxRef) {
  const dropboxHeaders = new Headers({
    authorization: `Bearer ${accessToken}`,
    "dropbox-api-arg": JSON.stringify(dropboxDownloadArg(dropboxRef)),
  });

  const range = request.headers.get("range");
  if (range) {
    dropboxHeaders.set("range", range);
  }

  return fetch(dropboxDownloadUrl(dropboxRef), {
    method: "POST",
    headers: dropboxHeaders,
  });
}

async function readJsonRequest(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function dropboxRefFromBody(body) {
  const ref = String(body?.pdf_url || body?.pdfUrl || body?.dropbox || body?.dropboxUrl || body?.path || "").trim();
  if (!ref) {
    throw new HttpError(400, "Missing Dropbox file reference");
  }
  return ref;
}

function tocBackendPassword(staffPassword, env) {
  return env.DTL_STAFF_PASSWORD || staffPassword;
}

async function relayBackendResponse(backendResponse, request, env) {
  const text = await backendResponse.text();
  const backendStatus = backendResponse.status || 502;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    const retryable = backendStatus === 408 || backendStatus === 429 || backendStatus >= 500;
    return json(
      {
        error: retryable
          ? "ToC backend is temporarily unavailable. Retrying may work."
          : "ToC backend returned an unexpected response.",
        retryable,
        backend_status: backendStatus,
      },
      request,
      env,
      backendStatus,
    );
  }

  const headers = corsHeaders(request, env);
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(parsed, null, 2), {
    status: backendStatus,
    headers,
  });
}

async function dropboxErrorResponse(dropboxResponse, request, env) {
  const details = await dropboxResponse.text().catch(() => "");
  const safeDetails = summarizeDropboxError(details);
  console.warn("Dropbox download failed", {
    status: dropboxResponse.status,
    details: safeDetails,
  });
  return json(
    {
      error: "Dropbox download failed",
      status: dropboxResponse.status,
      details: safeDetails,
      hint: dropboxErrorHint(safeDetails),
    },
    request,
    env,
    502,
  );
}

async function resolveDropboxRefForDownload(accessToken, dropboxRef) {
  if (!isDropboxSharedLink(dropboxRef)) {
    return dropboxRef;
  }

  const metadata = await getSharedLinkMetadata(accessToken, dropboxRef);
  const fileRef = metadata.id || metadata.path_lower || metadata.path_display;
  if (!fileRef) {
    console.warn("Dropbox shared link metadata had no downloadable file reference", {
      tag: metadata[".tag"] || null,
      name: metadata.name || null,
    });
    return dropboxRef;
  }
  return fileRef;
}

async function getSharedLinkMetadata(accessToken, sharedLink) {
  const response = await fetch(DROPBOX_SHARED_LINK_METADATA_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url: sharedLink }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    data = null;
  }

  if (!response.ok) {
    const safeDetails = summarizeDropboxError(text);
    console.warn("Dropbox shared link metadata failed", {
      status: response.status,
      details: safeDetails,
    });
    throw new HttpError(
      502,
      `Dropbox shared link metadata failed: ${dropboxErrorHint(safeDetails)} ${safeDetails}`,
    );
  }

  return data || {};
}

async function getDropboxAccessToken(env) {
  if (env.DROPBOX_ACCESS_TOKEN) {
    return env.DROPBOX_ACCESS_TOKEN;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedDropboxAccessToken && cachedDropboxAccessToken.expiresAt > now + 60) {
    return cachedDropboxAccessToken.token;
  }

  requireEnv(env, "DROPBOX_REFRESH_TOKEN");
  requireEnv(env, "DROPBOX_APP_KEY");
  requireEnv(env, "DROPBOX_APP_SECRET");

  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new HttpError(502, `Dropbox token refresh failed: ${details.slice(0, 300)}`);
  }

  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new HttpError(502, "Dropbox token refresh response did not include an access token");
  }

  cachedDropboxAccessToken = {
    token: tokenData.access_token,
    expiresAt: now + Number(tokenData.expires_in || 14400),
  };

  return cachedDropboxAccessToken.token;
}

function buildPayload(input) {
  const dropboxRef = normalizeDropboxRef(input.dropbox);
  const start = parsePositiveInteger(input.start, "start");
  const end = parsePositiveInteger(input.end, "end");

  if (end < start) {
    throw new HttpError(400, "end must be greater than or equal to start");
  }

  const now = Math.floor(Date.now() / 1000);
  const chapterLength = end - start + 1;
  const mode = String(input.mode || "pdf").trim().toLowerCase();
  const payload = {
    v: 2,
    dbx: dropboxRef,
    ss: start,
    se: end,
    s: 1,
    e: chapterLength,
    d: isTruthy(input.download) ? 1 : 0,
    c: String(input.chapter || "Chapter").slice(0, 180),
    iat: now,
  };
  const filename = normalizeChapterFilename(input.filename);
  if (filename) {
    payload.fn = filename;
  }

  if (mode !== "pdf") {
    throw new HttpError(400, "mode must be pdf");
  }

  const expiresMinutes = Number(input.expires || 0);
  if (Number.isFinite(expiresMinutes) && expiresMinutes > 0) {
    payload.exp = now + Math.floor(expiresMinutes * 60);
  }

  return payload;
}

function normalizeChapterFilename(value) {
  if (typeof value !== "string") return "";
  const stem = value.normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, "-")
    .replace(/[\uD800-\uDFFF]/gu, "-")
    .trim().replace(/\.pdf$/i, "").replace(/^[ .]+|[ .]+$/g, "");
  if (!stem) return "";
  // Keep the book/volume prefix when a long chapter title needs shortening.
  const encoder = new TextEncoder();
  let name = "", bytes = 0;
  for (const character of stem) {
    const length = encoder.encode(character).length;
    if (bytes + length > 236) break;
    name += character;
    bytes += length;
  }
  return name.trimEnd() + ".pdf";
}

function setChapterFilename(headers, filename) {
  if (!filename) return;
  const ascii = filename.replace(/[^\x20-\x7e]|%/gu, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
    character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  headers.set("content-disposition", `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`);
}

function normalizeDropboxRef(value) {
  const ref = String(value || "").trim();
  if (!ref) {
    throw new HttpError(400, "Missing Dropbox file reference");
  }

  if (/^https?:\/\//i.test(ref)) {
    try {
      const url = new URL(ref);
      if (url.hostname === "dropbox.com" || url.hostname.endsWith(".dropbox.com")) {
        return ref;
      }
    } catch {}
    throw new HttpError(400, "Dropbox URL must be a dropbox.com shared link");
  }

  if (ref.startsWith("/") || ref.startsWith("id:") || ref.startsWith("rev:")) {
    return ref;
  }

  throw new HttpError(400, "Dropbox reference must be a shared link, /path, id:, or rev:");
}

function dropboxDownloadUrl(dropboxRef) {
  return isDropboxSharedLink(dropboxRef) ? DROPBOX_SHARED_LINK_FILE_URL : DROPBOX_DOWNLOAD_URL;
}

function dropboxDownloadArg(dropboxRef) {
  return isDropboxSharedLink(dropboxRef) ? { url: dropboxRef } : { path: dropboxRef };
}

function isDropboxSharedLink(dropboxRef) {
  return /^https?:\/\/([^/]+\.)?dropbox\.com\//i.test(dropboxRef);
}

function summarizeDropboxError(details) {
  return String(details || "")
    .replace(/https?:\/\/[^\s"']*dropbox[^\s"']*/gi, "[dropbox-link]")
    .slice(0, 500);
}

function dropboxErrorHint(details) {
  const text = String(details || "").toLowerCase();
  if (text.includes("missing_scope") || text.includes("sharing.read")) {
    return "The Dropbox app needs the sharing.read permission, then the refresh token must be recreated.";
  }
  if (text.includes("shared_link")) {
    return "The shared link route failed. For no-download PDFs, use the file path or file ID inside the authorized Dropbox account.";
  }
  if (text.includes("not_found") || text.includes("path/not_found")) {
    return "Dropbox could not find this file through the current app access. Check that the app was authorized against the Dropbox account that owns the PDF.";
  }
  return "Use the Dropbox error details to decide the next setup step.";
}

function summarizeSlicerError(details) {
  return String(details || "")
    .replace(/https?:\/\/[^\s"']*/gi, "[url]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[token]")
    .slice(0, 500);
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new HttpError(400, `${label} must be a positive whole number`);
  }
  return number;
}

function requirePdfPayload(payload) {
  if (payload.m && payload.m !== "pdf") {
    throw new HttpError(400, "This token is not a PDF reader token");
  }
}

function validatePdfRequestSource(request, env) {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return null;
  }

  const allowedOrigins = allowedPdfRequestOrigins(env);
  if (allowedOrigins.length === 0) {
    return null;
  }

  const origin = request.headers.get("origin");
  if (origin && allowedOrigins.includes(origin)) {
    return null;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (allowedOrigins.includes(new URL(referer).origin)) {
        return null;
      }
    } catch {}
  }

  return "This chapter link must be opened from the approved chapter reader";
}

function allowedPdfRequestOrigins(env) {
  return String(env.ALLOWED_PDF_REQUEST_ORIGINS || env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "yes";
}

function publicPayload(payload) {
  return {
    s: payload.s,
    e: payload.e,
    d: payload.d,
    c: payload.c,
    ...(payload.fn ? { fn: payload.fn } : {}),
    exp: payload.exp || null,
  };
}

function requireStaffPassword(request, env) {
  const url = new URL(request.url);
  requireStaffPasswordValue(url.searchParams.get("password"), env);
}

function requireStaffPasswordValue(password, env) {
  requireEnv(env, "STAFF_PASSWORD");
  if (!password || password !== env.STAFF_PASSWORD) {
    throw new HttpError(401, "Unauthorized");
  }
}

function requireSlicerSecret(request, env) {
  requireEnv(env, "SLICER_SHARED_SECRET");
  const provided = request.headers.get("x-dtl-slicer-secret") || "";
  if (!constantTimeStringEqual(provided, env.SLICER_SHARED_SECRET)) {
    throw new HttpError(401, "Unauthorized");
  }
}

function requireEnv(env, key) {
  if (!env[key]) {
    throw new HttpError(500, `Missing ${key} secret`);
  }
}

function hasSlicerConfig(env) {
  return Boolean(env.SLICER_SERVICE_URL && env.SLICER_SHARED_SECRET);
}

function normalizedServiceUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(url)) {
    throw new HttpError(500, "SLICER_SERVICE_URL must be an HTTPS URL");
  }
  return url;
}

function constantTimeStringEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function signToken(payload, env) {
  requireEnv(env, "TOKEN_SECRET");
  const tokenPayload = { ...payload };
  if (tokenPayload.dbx) {
    tokenPayload.p = await encryptPrivatePayload({
      dbx: tokenPayload.dbx,
      ss: tokenPayload.ss,
      se: tokenPayload.se,
    }, env);
    delete tokenPayload.dbx;
    delete tokenPayload.ss;
    delete tokenPayload.se;
  }
  const encodedPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(tokenPayload)));
  const signature = await hmacSign(encodedPayload, env.TOKEN_SECRET);
  return `${encodedPayload}.${base64UrlEncodeBytes(signature)}`;
}

async function signReaderSession(token, request, env) {
  requireEnv(env, "TOKEN_SECRET");

  const now = Math.floor(Date.now() / 1000);
  const sessionPayload = {
    v: 1,
    typ: "reader-session",
    th: await sha256Base64Url(token),
    uh: await sha256Base64Url(request.headers.get("user-agent") || ""),
    iat: now,
    exp: now + READER_SESSION_TTL_SECONDS,
  };
  const encodedPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(sessionPayload)));
  const signature = await hmacSign(`reader-session.${encodedPayload}`, env.TOKEN_SECRET);
  return `${encodedPayload}.${base64UrlEncodeBytes(signature)}`;
}

async function verifyReaderSession(session, token, request, env) {
  requireEnv(env, "TOKEN_SECRET");
  if (!session) {
    throw new HttpError(401, "Missing reader session");
  }

  const parts = session.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(401, "Invalid reader session");
  }

  let provided;
  try {
    provided = base64UrlDecodeToBytes(parts[1]);
  } catch {
    throw new HttpError(401, "Invalid reader session");
  }

  const verified = await hmacVerify(`reader-session.${parts[0]}`, env.TOKEN_SECRET, provided);
  if (!verified) {
    throw new HttpError(401, "Invalid reader session");
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(parts[0])));
  } catch {
    throw new HttpError(401, "Invalid reader session");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== "reader-session" || !payload.exp || payload.exp < now) {
    throw new HttpError(401, "Reader session expired");
  }
  if (payload.th !== await sha256Base64Url(token)) {
    throw new HttpError(401, "Reader session does not match this chapter link");
  }
  if (payload.uh !== await sha256Base64Url(request.headers.get("user-agent") || "")) {
    throw new HttpError(401, "Reader session does not match this browser");
  }
}

async function verifyToken(token, env) {
  requireEnv(env, "TOKEN_SECRET");

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(401, "Invalid token");
  }

  let provided;
  try {
    provided = base64UrlDecodeToBytes(parts[1]);
  } catch {
    throw new HttpError(401, "Invalid token signature");
  }
  const verified = await hmacVerify(parts[0], env.TOKEN_SECRET, provided);
  if (!verified) {
    throw new HttpError(401, "Invalid token signature");
  }

  let payload;
  try {
    const payloadText = new TextDecoder().decode(base64UrlDecodeToBytes(parts[0]));
    payload = JSON.parse(payloadText);
  } catch {
    throw new HttpError(401, "Invalid token payload");
  }
  parsePositiveInteger(payload.s, "start");
  parsePositiveInteger(payload.e, "end");
  if (payload.p) {
    const privatePayload = await decryptPrivatePayload(payload.p, env);
    payload.dbx = privatePayload.dbx;
    payload.ss = privatePayload.ss;
    payload.se = privatePayload.se;
  }
  payload.dbx = normalizeDropboxRef(payload.dbx);
  payload.ss = parsePositiveInteger(payload.ss || payload.s, "source start");
  payload.se = parsePositiveInteger(payload.se || payload.e, "source end");
  if (payload.se < payload.ss) {
    throw new HttpError(401, "Invalid source page range");
  }
  return payload;
}

async function encryptPrivatePayload(payload, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(env.TOKEN_SECRET);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return base64UrlEncodeBytes(combined);
}

async function decryptPrivatePayload(value, env) {
  try {
    const combined = base64UrlDecodeToBytes(value);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await aesKey(env.TOKEN_SECRET);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new HttpError(401, "Invalid private token payload");
  }
}

async function aesKey(secret) {
  const secretHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", secretHash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function hmacVerify(message, secret, providedSignature) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, providedSignature, new TextEncoder().encode(message));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(value) {
  let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyHeader(from, to, name) {
  const value = from.get(name);
  if (value) {
    to.set(name, value);
  }
}

function json(body, request, env, status = 200) {
  const headers = corsHeaders(request, env);
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

  const origin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0] || "*";

  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    "access-control-allow-headers": "content-type,range",
    "access-control-expose-headers": "accept-ranges,content-disposition,content-length,content-range,content-type,etag,last-modified,x-dtl-chapter-page-count,x-dtl-chapter-pages,x-dtl-fallback-reason,x-dtl-reader-session,x-dtl-restriction-mode,x-dtl-slicer-mode,x-dtl-slicer-ms,x-dtl-source-pages",
    vary: "Origin",
  });
}
