"""URSA SDK environment configuration for the hosted Log Reader.

The server holds ONE machine credential and fetches bags on behalf of anonymous
users -- there is no per-user login. Unlike the core-stack BagReader (which mints
a per-developer token via the offboard `inject_ursa_credentials.sh` script), this
standalone/hosted app expects the token and OCI bucket credentials to be provided
by the environment:

  - locally:  `source <core-stack>/offboard/offroad/scripts/inject_ursa_credentials.sh --local`
              (exports URSA_SDK_GRPC_AUTH_TOKEN), plus an OCI object-storage profile
              in ~/.aws (AWS_PROFILE, default "oci").
  - deployed: URSA_SDK_GRPC_AUTH_TOKEN + AWS creds injected from a secret.

configure_ursa_env() only fills in sensible defaults; it never mints and never
raises. When no token is present, OCI acquisition reports "unavailable" via
/api/status and the drag-drop viewer still works.
"""

import logging
import os

logger = logging.getLogger(__name__)

# Offboard URSA gRPC endpoint. Override via URSA_SDK_GRPC_HOSTNAME.
DEFAULT_URSA_HOSTNAME = "grpc.offroad.applied.dev"

# OCI object-storage AWS profile used for the actual log-object downloads.
# Override via BAG_READER_AWS_PROFILE.
DEFAULT_AWS_PROFILE = "oci"


def configure_ursa_env() -> None:
    """Set URSA SDK env defaults from the server's environment. Call once at startup."""
    # The dev container may export URSA_SDK_GRPC_HOSTNAME as an empty string;
    # overwrite when unset OR empty, while respecting a non-empty override.
    if not os.environ.get("URSA_SDK_GRPC_HOSTNAME"):
        os.environ["URSA_SDK_GRPC_HOSTNAME"] = DEFAULT_URSA_HOSTNAME

    # OCI bucket access profile. Only set a default when neither AWS_PROFILE nor
    # explicit key-based creds are already provided (e.g. by a deployed secret).
    if not os.environ.get("AWS_PROFILE") and not os.environ.get("AWS_ACCESS_KEY_ID"):
        os.environ["AWS_PROFILE"] = os.environ.get(
            "BAG_READER_AWS_PROFILE", DEFAULT_AWS_PROFILE
        )

    if os.environ.get("URSA_SDK_GRPC_AUTH_TOKEN"):
        logger.info(
            "URSA OCI acquisition enabled (host=%s, profile=%s)",
            os.environ["URSA_SDK_GRPC_HOSTNAME"],
            os.environ.get("AWS_PROFILE", "<env creds>"),
        )
    else:
        logger.warning(
            "No URSA_SDK_GRPC_AUTH_TOKEN in the server environment -- OCI "
            "acquisition is off (drag-drop still works). Provide a token via a "
            "secret, or `source offroad/scripts/inject_ursa_credentials.sh --local`."
        )
