#!/usr/bin/env bash
# Local dev launch WITH OCI/URSA bag fetch enabled.
#
# Mints a URSA token from your local AWS creds, then starts the server so the
# run-id / bag-link box is live and the server can fetch bags. (Plain `make dev`
# starts the server WITHOUT a token -> drag-drop only.)
#
# Usage:  ./dev-oci.sh        (from the repo root)
#
# Requires: ursa-py installed in the venv (see `make install-oci`), and a valid
# default AWS SSO session (so the token can be minted).

cd "$(dirname "$0")" || exit 1

# Drop any stale server holding the port (e.g. a previous tokenless launch).
pkill -f 'uvicorn src.server:app' 2>/dev/null
sleep 1

# Mint the token into this shell (exports URSA_SDK_GRPC_AUTH_TOKEN). Non-fatal:
# if it fails, the server still runs in drag-drop mode.
INJECT="$HOME/core-stack/offboard/offroad/scripts/inject_ursa_credentials.sh"
if [ -f "$INJECT" ]; then
  # shellcheck disable=SC1090
  source "$INJECT" --local
else
  echo "[dev-oci] inject script not found at $INJECT -- starting without a token." >&2
fi

# exec so uvicorn inherits the token we just exported.
exec ./venv/bin/uvicorn src.server:app --reload --port 8000
