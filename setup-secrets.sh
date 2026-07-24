#!/usr/bin/env bash
# One-time (re-run when creds rotate): load the machine + OCI credentials into
# apps-platform as this service's secrets.
#
#   - Machine creds (CLIENT_ID/CLIENT_SECRET): from AWS Secrets Manager secret
#     `echelon-machine-auth-local` (your echelon-accessible account).
#   - OCI object-storage creds: from your local `oci` AWS profile (the same creds
#     the app uses locally -- the `offroad-oci-bucket-creds` secret is a cloud/CI
#     secret your account can't read). NOTE: these are your profile's creds; for a
#     long-lived shared service, swap in dedicated service creds later.
#
# Secret VALUES never print to the screen -- they pass through a mode-600 temp file
# shredded on exit. Run this yourself; do not paste any values anywhere.
#
# Requires: your default AWS SSO session (echelon access), an `oci` AWS profile, jq,
# apps-platform.  Usage:  ./setup-secrets.sh

set -uo pipefail
cd "$(dirname "$0")"

REGION=us-west-2
tmp="$(mktemp)"
chmod 600 "$tmp"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT

echo "[1/3] Reading echelon-machine-auth-local (CLIENT_ID / CLIENT_SECRET)..."
mach="$(aws secretsmanager get-secret-value \
          --secret-id echelon-machine-auth-local --region "$REGION" \
          --query SecretString --output text 2>&1)" || {
  echo "ERROR reading echelon-machine-auth-local:" >&2
  echo "  $mach" >&2
  echo "  (is your default AWS SSO session current? -> awslogin --sso)" >&2
  exit 1
}
printf '%s' "$mach" | jq -r '"CLIENT_ID=\(.CLIENT_ID)\nCLIENT_SECRET=\(.CLIENT_SECRET)"' >> "$tmp"

echo "[2/3] Reading OCI object-storage creds from your local 'oci' profile..."
oci_key="$(aws configure get aws_access_key_id --profile oci 2>/dev/null || true)"
oci_secret="$(aws configure get aws_secret_access_key --profile oci 2>/dev/null || true)"
oci_region="$(aws configure get region --profile oci 2>/dev/null || true)"
oci_endpoint="$(grep -m1 endpoint_url "$HOME/.aws/config" 2>/dev/null | sed -E 's/.*=[[:space:]]*//' || true)"
{
  echo "AWS_ACCESS_KEY_ID=$oci_key"
  echo "AWS_SECRET_ACCESS_KEY=$oci_secret"
  echo "AWS_REGION=$oci_region"
  echo "AWS_ENDPOINT_URL_S3=$oci_endpoint"
} >> "$tmp"

# Fail loudly if any field is empty/null. Check the VALUE after the first '=' (not
# a regex on the whole line) so secrets that legitimately end in '=' (base64
# padding) are not false-flagged as empty.
missing=""
while IFS= read -r line; do
  key="${line%%=*}"
  val="${line#*=}"
  if [ -z "$val" ] || [ "$val" = "null" ]; then
    missing="$missing $key"
  fi
done < "$tmp"
if [ -n "$missing" ]; then
  echo "ERROR: empty field(s) (values NOT shown):$missing" >&2
  exit 1
fi

echo "[3/3] Loading 6 secrets into apps-platform (service: log-reader)..."
apps-platform app secret set --env "$tmp"

echo
echo "Done. Secret names now set:"
apps-platform app secret list
