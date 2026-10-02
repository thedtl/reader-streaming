# Dropbox App Setup

Use this when creating the Dropbox API access for the lab Worker.

Do not paste tokens, app secrets, or refresh tokens into chat. Store them only in
Cloudflare Worker secrets when we reach that step.

## Recommended app settings

1. Go to the Dropbox App Console: https://www.dropbox.com/developers/apps
2. Create a new app.
3. Choose `Scoped access`.
4. Choose the narrowest file access that will work:
   - `App folder` if the PDFs can live inside the app folder.
   - `Full Dropbox` only if the Worker must read PDFs already stored elsewhere
     in the account.
5. Name the app something clear, such as `DTL Chapter Reader Lab`.
6. In the app's Permissions tab, enable read-only file access:
   - `files.content.read`
   - `files.metadata.read`
   - `sharing.read` if you want to use Dropbox shared links instead of file
     paths.
7. Save/submit the permission changes.

## Token setup

For durable server-side access, use OAuth with offline access so Dropbox returns
a refresh token. The Worker can then exchange that refresh token for fresh
short-lived access tokens.

Needed Cloudflare secrets:

- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`

For a first smoke test, a generated access token can prove the Worker can read
one PDF. That token should be treated as temporary because Dropbox access tokens
expire.

The local helper script `scripts/dropbox-refresh-token-helper.sh` walks through
this flow without committing secrets.

For a browser-based local setup, run:

```sh
node scripts/dropbox-token-wizard/server.js
```

Then open `http://127.0.0.1:8789/`.
