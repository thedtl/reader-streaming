# Manual Setup Checklist

This experiment needs a few manual setup steps because Dropbox and Cloudflare
secrets should not be pasted into chat or committed to GitHub.

## Dropbox

Goal: create a Dropbox app/token that lets the Worker read PDFs server-side.

Needed later:

- Dropbox app with file read permission.
- A Dropbox refresh-token setup suitable for the account that owns the PDFs.
- A test PDF file reference, preferably a Dropbox API file ID such as `id:...`
  or a path such as `/Folder/Book.pdf`.

Do not put the Dropbox token in browser JavaScript, GitHub Pages, or a committed
file.

## Cloudflare Worker

Goal: store secrets in Cloudflare and deploy the lab Worker.

Needed later:

- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `TOKEN_SECRET`
- `STAFF_PASSWORD`

These should be set with `wrangler secret put ...` or through the Cloudflare
dashboard's Worker secret settings.

For a quick smoke test only, the Worker can use `DROPBOX_ACCESS_TOKEN` instead
of the three Dropbox refresh-token secrets. The refresh-token setup is preferred
because Dropbox access tokens expire.

## First live test

After secrets are set:

1. Deploy the lab Worker.
2. Generate a staff-only signed test token for one Dropbox PDF chapter.
3. Open the lab PDF.js viewer with `file=` pointed at the lab Worker URL.
4. Confirm the PDF loads and the Worker response header says
   `x-dtl-restriction-mode: chapter-only-pdf`.
5. Confirm the Worker response header says `x-dtl-reader-session: required`.
6. Confirm browser network requests do not show a Dropbox API token.
7. Confirm browser network requests do not show a Dropbox shared link.
8. Confirm the browser receives only the selected chapter pages, not the full
   source PDF page count.
9. Confirm the raw Worker PDF URL fails when opened directly, without the
   approved PDF.js viewer as the request source.
10. Confirm the raw Worker PDF URL also fails without a fresh `session=...`.
11. Compare large-PDF load behavior with the live reader.

## Important limitation

The Worker now creates a temporary chapter-only PDF for patron links, which is a
stronger restriction than simply hiding PDF.js buttons.

This still sends PDF bytes for the selected chapter to the browser. The current
protection goal is to make copied URLs hard to reuse by combining the customized
PDF.js viewer restrictions, a short-lived reader session, and a Worker-side
allowed-source check.
