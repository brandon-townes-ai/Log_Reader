"""URSA SDK environment configuration for the hosted Log Reader.

The server holds ONE machine credential and fetches bags on behalf of anonymous
users -- there is no per-user login.

Token resolution (first that applies wins):
  1. URSA_SDK_GRPC_AUTH_TOKEN already in the env -> used directly. This is the
     LOCAL dev path: `source inject_ursa_credentials.sh --local` exports it.
  2. CLIENT_ID + CLIENT_SECRET in the env -> the server mints a short-lived token
     from accounts.applied.co and refreshes it in the background. This is the
     DEPLOYMENT path: inject the two machine creds as apps-platform secrets; no
     AWS Secrets Manager access is required.

OCI object-storage credentials for the actual downloads come from the env:
  - locally:  an AWS profile (AWS_PROFILE, default "oci") in ~/.aws.
  - deployed: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION /
              AWS_ENDPOINT_URL_S3 injected as secrets.

configure_ursa_env() never raises; without creds the drag-drop viewer still works.
"""

import json
import logging
import os
import threading
import time
import urllib.request

logger = logging.getLogger(__name__)

# Offboard URSA gRPC endpoint. Override via URSA_SDK_GRPC_HOSTNAME.
DEFAULT_URSA_HOSTNAME = "grpc.offroad.applied.dev"

# OCI object-storage AWS profile used for the log-object downloads (local dev).
# Override via BAG_READER_AWS_PROFILE.
DEFAULT_AWS_PROFILE = "oci"

# Machine-credential exchange endpoint (mirrors inject_ursa_credentials.sh).
_MACHINE_CRED_URL = "https://accounts.applied.co/api/machineCredential/get"

# Machine-auth tokens are short-lived; re-mint on this cadence when we hold the
# CLIENT_ID/CLIENT_SECRET (deployment path).
_TOKEN_REFRESH_SECONDS = 30 * 60


def _mint_token_from_client_creds() -> str | None:
    """Exchange CLIENT_ID/CLIENT_SECRET for a machine-auth token. None on failure."""
    cid = os.environ.get("CLIENT_ID")
    secret = os.environ.get("CLIENT_SECRET")
    if not cid or not secret:
        return None
    payload = json.dumps({"client_id": cid, "client_secret": secret}).encode()
    req = urllib.request.Request(
        _MACHINE_CRED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as exc:  # network / HTTP / JSON
        logger.error("failed to mint URSA token from CLIENT_ID/SECRET: %s", exc)
        return None
    token = data.get("machine_auth_token")
    if not token:
        logger.error("machineCredential response contained no machine_auth_token")
        return None
    return token


def _refresh_loop() -> None:
    """Periodically re-mint the token so a long-running server never goes stale."""
    while True:
        time.sleep(_TOKEN_REFRESH_SECONDS)
        token = _mint_token_from_client_creds()
        if token:
            os.environ["URSA_SDK_GRPC_AUTH_TOKEN"] = token
            logger.info("refreshed URSA token")
        else:
            logger.warning("URSA token refresh failed; keeping previous token")


# Secrets pulled from GCP Secret Manager when running on apps-platform. The
# service account has read access (project.toml `enable_secrets = true`), but
# apps-platform does NOT inject them as env vars -- the app reads them at startup,
# mirroring the platform's reference apps. Each is stored under
# "<service>-<name lowercased, '_' -> '-'>".
_GCP_SECRET_ENV_VARS = (
    "CLIENT_ID",
    "CLIENT_SECRET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "AWS_ENDPOINT_URL_S3",
)


def _load_secrets_from_gcp() -> None:
    """On apps-platform, fetch our secrets from Secret Manager into os.environ.

    No-op locally (no PROJECT_ID) and for any value already present in the env, so
    local dev (env token via inject script) is unaffected. Never raises.
    """
    project_id = os.environ.get("PROJECT_ID")
    if not project_id:
        return
    service = os.environ.get("K_SERVICE", "log-reader")
    try:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
    except Exception as exc:
        logger.warning("Secret Manager client unavailable: %s", exc)
        return
    for env_var in _GCP_SECRET_ENV_VARS:
        if os.environ.get(env_var):
            continue
        suffix = env_var.lower().replace("_", "-")
        name = f"projects/{project_id}/secrets/{service}-{suffix}/versions/latest"
        try:
            resp = client.access_secret_version(request={"name": name})
            os.environ[env_var] = resp.payload.data.decode("utf-8")
        except Exception as exc:
            logger.warning("could not load secret %s: %s", name, exc)


def configure_ursa_env() -> None:
    """Set URSA SDK env from the server's environment. Call once at startup."""
    # On apps-platform, pull our secrets from Secret Manager into the env first.
    _load_secrets_from_gcp()

    # OCI's S3-compat API rejects PutObject/GetObject without these (see the OCI
    # cookbook's MissingContentLength note). Harmless elsewhere.
    os.environ.setdefault("AWS_REQUEST_CHECKSUM_CALCULATION", "when_required")
    os.environ.setdefault("AWS_RESPONSE_CHECKSUM_VALIDATION", "when_required")

    # Overwrite an unset OR empty hostname (the dev container exports it empty),
    # while respecting a non-empty override.
    if not os.environ.get("URSA_SDK_GRPC_HOSTNAME"):
        os.environ["URSA_SDK_GRPC_HOSTNAME"] = DEFAULT_URSA_HOSTNAME

    # OCI bucket access profile -- only default it when neither a profile nor
    # explicit key-based creds are already provided (e.g. by deployed secrets).
    if not os.environ.get("AWS_PROFILE") and not os.environ.get("AWS_ACCESS_KEY_ID"):
        os.environ["AWS_PROFILE"] = os.environ.get(
            "BAG_READER_AWS_PROFILE", DEFAULT_AWS_PROFILE
        )

    have_client_creds = bool(os.environ.get("CLIENT_ID")) and bool(
        os.environ.get("CLIENT_SECRET")
    )

    # Deployment path: no token yet, but we can mint one from machine creds.
    if not os.environ.get("URSA_SDK_GRPC_AUTH_TOKEN") and have_client_creds:
        token = _mint_token_from_client_creds()
        if token:
            os.environ["URSA_SDK_GRPC_AUTH_TOKEN"] = token

    # Keep the token fresh whenever we hold the machine creds (also retries if the
    # first mint above failed).
    if have_client_creds:
        threading.Thread(target=_refresh_loop, daemon=True).start()

    if os.environ.get("URSA_SDK_GRPC_AUTH_TOKEN"):
        logger.info(
            "URSA OCI acquisition enabled (host=%s, profile=%s)",
            os.environ["URSA_SDK_GRPC_HOSTNAME"],
            os.environ.get("AWS_PROFILE", "<env creds>"),
        )
    else:
        logger.warning(
            "No URSA token and no CLIENT_ID/CLIENT_SECRET in the environment -- "
            "OCI acquisition is off (drag-drop still works). Locally: `source "
            "inject_ursa_credentials.sh --local`. Deployed: set CLIENT_ID / "
            "CLIENT_SECRET secrets."
        )
