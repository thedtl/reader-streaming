#!/usr/bin/env bash
set -euo pipefail

echo "DTL Dropbox refresh-token helper"
echo
echo "This helper keeps secrets local. Do not paste app secrets or tokens into chat."
echo

read -r -p "Dropbox app key: " APP_KEY
if [[ -z "${APP_KEY}" ]]; then
  echo "Missing app key" >&2
  exit 1
fi

AUTH_URL="https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline&scope=files.content.read%20files.metadata.read%20sharing.read"

echo
echo "Open this URL in your browser, approve access, then copy the authorization code Dropbox shows:"
echo
echo "${AUTH_URL}"
echo

read -r -p "Authorization code from Dropbox: " AUTH_CODE
if [[ -z "${AUTH_CODE}" ]]; then
  echo "Missing authorization code" >&2
  exit 1
fi

read -r -s -p "Dropbox app secret (input hidden): " APP_SECRET
echo
if [[ -z "${APP_SECRET}" ]]; then
  echo "Missing app secret" >&2
  exit 1
fi

echo
echo "Requesting refresh token from Dropbox..."
echo

RESPONSE="$(
  curl -sS https://api.dropboxapi.com/oauth2/token \
    -u "${APP_KEY}:${APP_SECRET}" \
    -d "code=${AUTH_CODE}" \
    -d "grant_type=authorization_code"
)"

REFRESH_TOKEN="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); if (data.error) { console.error(JSON.stringify(data, null, 2)); process.exit(1); } console.log(data.refresh_token || "");' <<< "${RESPONSE}")"

if [[ -z "${REFRESH_TOKEN}" ]]; then
  echo "Dropbox did not return a refresh token. Full response:" >&2
  echo "${RESPONSE}" >&2
  exit 1
fi

echo "Success. Keep this refresh token private."
echo
echo "DROPBOX_REFRESH_TOKEN=${REFRESH_TOKEN}"
echo
echo "Next Cloudflare secrets will be:"
echo "DROPBOX_REFRESH_TOKEN: the value printed above"
echo "DROPBOX_APP_KEY: your Dropbox app key"
echo "DROPBOX_APP_SECRET: your Dropbox app secret"
