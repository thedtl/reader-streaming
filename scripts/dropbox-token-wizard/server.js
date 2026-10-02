import { createServer } from "node:http";

const PORT = 8789;
const HOST = "127.0.0.1";
const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_SCOPES = "files.content.read files.metadata.read sharing.read";

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DTL Dropbox Token Wizard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #5f697a;
      --line: #d8dee8;
      --panel: #ffffff;
      --back: #f5f7fa;
      --blue: #154889;
      --red: #af161c;
      --green: #197a4d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--back);
    }
    main {
      max-width: 840px;
      margin: 0 auto;
      padding: 28px 18px 48px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0;
    }
    p { margin: 0 0 16px; color: var(--muted); }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin: 16px 0;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 12px;
      letter-spacing: 0;
    }
    label {
      display: block;
      font-weight: 650;
      margin: 12px 0 6px;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 11px 12px;
      font: inherit;
      background: #fff;
    }
    textarea {
      min-height: 108px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    button, a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      border: 0;
      border-radius: 6px;
      padding: 10px 14px;
      font: inherit;
      font-weight: 750;
      cursor: pointer;
      text-decoration: none;
      color: #fff;
      background: var(--blue);
      margin: 8px 8px 0 0;
    }
    button.secondary { background: #39475d; }
    button.danger { background: var(--red); }
    .note {
      border-left: 4px solid var(--blue);
      padding: 10px 12px;
      background: #eef4ff;
      color: #26364f;
      border-radius: 4px;
    }
    .ok {
      border-left-color: var(--green);
      background: #eefaf3;
    }
    .error {
      border-left-color: var(--red);
      background: #fff1f1;
      color: #5f1618;
    }
    .hidden { display: none; }
    code {
      background: #edf1f7;
      padding: 2px 5px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <main>
    <h1>DTL Dropbox Token Wizard</h1>
    <p>This page runs locally on your computer. It does not save your Dropbox app key, app secret, or tokens.</p>

    <section>
      <h2>1. Enter Dropbox App Details</h2>
      <label for="appKey">App key</label>
      <input id="appKey" autocomplete="off" spellcheck="false">

      <label for="appSecret">App secret</label>
      <input id="appSecret" type="password" autocomplete="off" spellcheck="false">

      <button id="makeAuthUrl">Create Dropbox Approval Link</button>
      <p id="authHelp" class="note hidden"></p>
    </section>

    <section id="authSection" class="hidden">
      <h2>2. Approve The App In Dropbox</h2>
      <p>Click the Dropbox approval link. Dropbox will show you a code after you approve the app.</p>
      <a id="authLink" class="button" href="#" target="_blank" rel="noopener">Open Dropbox Approval</a>
    </section>

    <section id="codeSection" class="hidden">
      <h2>3. Paste The Dropbox Code</h2>
      <label for="authCode">Authorization code from Dropbox</label>
      <input id="authCode" autocomplete="off" spellcheck="false">
      <button id="exchangeCode">Get Refresh Token</button>
      <p id="status" class="note hidden"></p>
    </section>

    <section id="resultSection" class="hidden">
      <h2>4. Keep These For Cloudflare Secrets</h2>
      <p class="note ok">Success. Do not paste these values into chat. We will put them into Cloudflare secrets next.</p>
      <label for="resultBox">Cloudflare secret values</label>
      <textarea id="resultBox" readonly></textarea>
      <button id="copyResult" class="secondary">Copy Values</button>
    </section>
  </main>

  <script>
    const appKeyEl = document.getElementById("appKey");
    const appSecretEl = document.getElementById("appSecret");
    const authCodeEl = document.getElementById("authCode");
    const authSection = document.getElementById("authSection");
    const codeSection = document.getElementById("codeSection");
    const resultSection = document.getElementById("resultSection");
    const authLink = document.getElementById("authLink");
    const authHelp = document.getElementById("authHelp");
    const statusEl = document.getElementById("status");
    const resultBox = document.getElementById("resultBox");

    function showMessage(el, text, type) {
      el.textContent = text;
      el.className = "note" + (type ? " " + type : "");
      el.classList.remove("hidden");
    }

    document.getElementById("makeAuthUrl").addEventListener("click", () => {
      const appKey = appKeyEl.value.trim();
      if (!appKey) {
        showMessage(authHelp, "Enter the App key first.", "error");
        return;
      }
      const url = new URL("https://www.dropbox.com/oauth2/authorize");
      url.searchParams.set("client_id", appKey);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("token_access_type", "offline");
      url.searchParams.set("scope", "${DROPBOX_SCOPES}");
      authLink.href = url.toString();
      authSection.classList.remove("hidden");
      codeSection.classList.remove("hidden");
      showMessage(authHelp, "Approval link created. Open it, approve the app, then paste the code Dropbox gives you below.");
    });

    document.getElementById("exchangeCode").addEventListener("click", async () => {
      const appKey = appKeyEl.value.trim();
      const appSecret = appSecretEl.value.trim();
      const code = authCodeEl.value.trim();
      resultSection.classList.add("hidden");

      if (!appKey || !appSecret || !code) {
        showMessage(statusEl, "Fill in App key, App secret, and the authorization code first.", "error");
        return;
      }

      showMessage(statusEl, "Asking Dropbox for the refresh token...");

      const response = await fetch("/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey, appSecret, code }),
      });

      const data = await response.json();
      if (!response.ok) {
        showMessage(statusEl, data.error || "Dropbox token exchange failed.", "error");
        return;
      }

      resultBox.value = [
        "DROPBOX_REFRESH_TOKEN=" + data.refreshToken,
        "DROPBOX_APP_KEY=" + appKey,
        "DROPBOX_APP_SECRET=" + appSecret,
      ].join("\\n");
      resultSection.classList.remove("hidden");
      showMessage(statusEl, "Refresh token created.", "ok");
    });

    document.getElementById("copyResult").addEventListener("click", async () => {
      await navigator.clipboard.writeText(resultBox.value);
    });
  </script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(page);
    return;
  }

  if (req.method === "POST" && req.url === "/exchange") {
    try {
      const body = await readJson(req);
      const tokenData = await exchangeCode(body);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ refreshToken: tokenData.refresh_token }));
    } catch (error) {
      res.writeHead(400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log("Dropbox token wizard is running.");
  console.log(`Open http://${HOST}:${PORT}/ in your browser.`);
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 20000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Could not read form data"));
      }
    });
    req.on("error", reject);
  });
}

async function exchangeCode(body) {
  const appKey = String(body.appKey || "").trim();
  const appSecret = String(body.appSecret || "").trim();
  const code = String(body.code || "").trim();

  if (!appKey || !appSecret || !code) {
    throw new Error("Missing App key, App secret, or authorization code");
  }

  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${appKey}:${appSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
    }),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Dropbox returned an unreadable response");
  }

  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Dropbox rejected the code");
  }

  if (!data.refresh_token) {
    throw new Error("Dropbox did not return a refresh token. Make sure the approval link was created from this page.");
  }

  return data;
}
