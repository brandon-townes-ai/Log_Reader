"""Acquire URSA/OCI run logs via the URSA SDK.

Thin, sync wrapper over ``ursa.public.sdk.python.log_management``, restricted to
a run's ``logs/`` prefix (DescribeRun + FileList + FileDownload). No MCAP /
data_processor.

The SDK is imported lazily so this module stays importable (and /api/status
answerable) even when ursa-py or credentials are unavailable.
"""

import logging
import os
import re
import tempfile
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# FileList prefix for a run's text logs.
LOGS_PREFIX = "logs"

# Cap on a single log fetch -- a guard against a pathological / binary object, not
# a memory bound (the API streams the file in chunks). Tunable via
# BAG_READER_MAX_FILE_BYTES. Note: on Cloud Run gen2 the temp file lives in /tmp
# (memory-backed), so very large logs still pressure the instance's RAM.
DEFAULT_MAX_BYTES = int(
    os.environ.get("BAG_READER_MAX_FILE_BYTES", str(512 * 1024 * 1024))
)


class OciError(Exception):
    """A run could not be resolved, or a log could not be listed/fetched."""


@dataclass
class LogFile:
    key: str  # full object path within the run, e.g. "logs/cloud_supervisor"
    name: str  # basename, for display
    size: int


def _log_management():
    """Import the URSA SDK lazily; raise OciError if it is unavailable."""
    try:
        from ursa.public.sdk.python import log_management
    except Exception as exc:  # ImportError or transitive import failure
        raise OciError(f"ursa-py unavailable: {exc}") from exc
    return log_management


def _normalize_run_ref(run_ref: str) -> str:
    """Reduce a pasted reference to the run-id/UUID token the SDK expects.

    Accepts a bare run-id/UUID (returned unchanged) or a URSA "bag link" URL,
    from which the last non-empty path segment is taken (query/fragment dropped).
    """
    ref = run_ref.strip()
    if "/" in ref:
        ref = ref.split("?", 1)[0].split("#", 1)[0]
        segments = [s for s in ref.split("/") if s]
        if segments:
            ref = segments[-1]
    return ref


# Resolved {uuid, custom_id} cache, keyed by normalized run-ref. The fallback
# search pages many runs, so we avoid repeating it for each subsequent log-file
# fetch in the same session.
_RESOLVE_CACHE: dict[str, dict] = {}

# How many recent drive runs the fallback search pages through. URSA's query API
# only supports exact (=) field filters, so the substring match is client-side.
SEARCH_SCAN_ROWS = 1000


def _cid(run) -> str:
    return getattr(getattr(run, "drive_run_info", None), "custom_id", "") or ""


def _uri(run) -> str:
    return getattr(run, "raw_data_uri", "") or ""


def _tokens(s: str) -> set[str]:
    """Lowercased alphanumeric tokens (splits on _ - / . etc.) for fuzzy matching."""
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def _run_to_info(run, fallback_id: str) -> dict:
    return {
        "uuid": str(getattr(run, "uuid", "")),
        "custom_id": _cid(run) or fallback_id,
    }


def _scan_drive_runs(lm) -> list:
    try:
        return list(lm.ListDriveRuns(num_rows=SEARCH_SCAN_ROWS))
    except Exception as exc:
        raise OciError(f"could not list drive runs: {exc}") from exc


def resolve_run(run_id: str) -> dict:
    """Resolve a custom-id / UUID / pasted bag link / folder name to ``{uuid, custom_id}``.

    Tries URSA's exact id resolution first (custom_id, UUID, ADP UUID). On a miss,
    scans recent drive runs once and:
      - a single substring match (custom_id or raw_data_uri) resolves it;
      - multiple substring matches raise an "ambiguous" error listing them;
      - no substring match raises a "did you mean ...?" error with the closest runs
        by token overlap (vehicle/date/run-type), so an approximate paste still
        points the user at the right run.
    """
    run_id = _normalize_run_ref(run_id)
    if run_id in _RESOLVE_CACHE:
        return _RESOLVE_CACHE[run_id]

    lm = _log_management()
    describe_err = ""
    try:
        info = _run_to_info(lm.DescribeRun(run_id), run_id)
        _RESOLVE_CACHE[run_id] = info
        return info
    except Exception as exc:
        # Exact id unknown -- keep the reason (the `as` name is cleared at block
        # exit, so bind it to a variable that survives) and fall through to search.
        describe_err = str(exc)

    runs = _scan_drive_runs(lm)
    needle = run_id.lower()
    substr = [r for r in runs if needle in _cid(r).lower() or needle in _uri(r).lower()]
    if len(substr) == 1:
        info = _run_to_info(substr[0], run_id)
        _RESOLVE_CACHE[run_id] = info
        return info
    if len(substr) > 1:
        names = ", ".join(_cid(r) for r in substr[:8])
        raise OciError(
            f"{run_id!r} matched {len(substr)} runs; use a more specific id. "
            f"Candidates: {names}"
        )

    # No substring match -- offer the closest runs by shared-token count.
    qtokens = _tokens(run_id)
    scored = sorted(
        ((len(qtokens & _tokens(_cid(r))), r) for r in runs), key=lambda sr: -sr[0]
    )
    threshold = max(2, len(qtokens) // 2)
    suggestions = [_cid(r) for score, r in scored[:6] if score >= threshold]
    if suggestions:
        raise OciError(
            f"no run found for {run_id!r}. Did you mean: " + "; ".join(suggestions)
        )
    raise OciError(
        f"no run found for {run_id!r} among recent drive runs ({describe_err})."
    )


def _run_fields(run, fallback_id: str = "") -> dict:
    """Pull the human-relevant identity fields off a Run proto, defensively."""
    dri = getattr(run, "drive_run_info", None)
    return {
        "uuid": str(getattr(run, "uuid", "")),
        "custom_id": getattr(dri, "custom_id", "") or fallback_id,
        "vehicle_name": getattr(dri, "vehicle_name", "") or "",
        "raw_data_uri": getattr(run, "raw_data_uri", "") or "",
    }


def diagnose(query: str, scan_rows: int = SEARCH_SCAN_ROWS) -> dict:
    """Report how ``query`` resolves, for debugging run lookups (no mutation).

    Shows the exact-id result, how many recent drive runs were scanned, any that
    substring-match the query, and a few samples so the real custom_id / vehicle /
    raw_data_uri formats are visible. Never raises for the search portion.
    """
    lm = _log_management()
    normalized = _normalize_run_ref(query)
    out: dict = {"query": query, "normalized": normalized}

    try:
        out["exact_describe"] = _run_fields(lm.DescribeRun(normalized), normalized)
    except Exception as exc:
        out["exact_describe_error"] = str(exc)

    needle = normalized.lower()
    try:
        drive = list(lm.ListDriveRuns(num_rows=scan_rows))
    except Exception as exc:
        out["list_drive_runs_error"] = str(exc)
        return out

    out["drive_runs_scanned"] = len(drive)
    fields = [_run_fields(r) for r in drive]
    out["matches"] = [
        f
        for f in fields
        if needle in f["custom_id"].lower() or needle in f["raw_data_uri"].lower()
    ]
    # Surface vehicle_name matches separately -- helps confirm the right field to
    # filter on server-side if custom_id/raw_data_uri don't contain the token.
    out["vehicle_substr_matches"] = sorted(
        {
            f["vehicle_name"]
            for f in fields
            if needle.split("_")[0] in f["vehicle_name"].lower()
        }
    )
    out["samples"] = fields[:5]
    return out


def _list_logs_for_uuid(uuid: str) -> list[LogFile]:
    lm = _log_management()
    try:
        files = list(lm.FileList(uuid, LOGS_PREFIX))
    except Exception as exc:
        raise OciError(f"could not list logs for run uuid {uuid}: {exc}") from exc
    out: list[LogFile] = []
    for f in files:
        path = f.path
        if path.endswith("/"):  # skip directory markers
            continue
        out.append(
            LogFile(
                key=path,
                name=os.path.basename(path),
                size=int(getattr(f, "size", 0) or 0),
            )
        )
    out.sort(key=lambda lf: lf.key)
    return out


def list_logs(run_id: str) -> tuple[dict, list[LogFile]]:
    """Return ``(run_info, [LogFile, ...])`` for the run's logs/ prefix."""
    info = resolve_run(run_id)
    return info, _list_logs_for_uuid(info["uuid"])


def fetch_log_to_path(run_id: str, key: str, max_bytes: int = DEFAULT_MAX_BYTES) -> str:
    """Download a single log object to a temp file and return its path.

    ``key`` MUST be a member of ``list_logs(run_id)`` (guards against path
    traversal / arbitrary-key fetches). Enforces a size cap before and after
    download. The CALLER owns the returned temp file and must delete it. Raises
    OciError on any violation or SDK failure (and cleans up the temp file itself).

    Returning a path (rather than bytes) lets the API stream the file in chunks --
    required because Cloud Run rejects non-streamed responses over 32 MiB, and to
    keep memory bounded for large logs.
    """
    info, files = list_logs(run_id)
    match = next((f for f in files if f.key == key), None)
    if match is None:
        raise OciError(f"{key!r} is not a log file of run {run_id!r}")
    if match.size and match.size > max_bytes:
        raise OciError(
            f"{key!r} is {match.size} bytes, exceeds cap of {max_bytes} bytes"
        )

    lm = _log_management()
    with tempfile.NamedTemporaryFile(suffix="_" + match.name, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        lm.FileDownload(info["uuid"], key, tmp_path)
        size = os.path.getsize(tmp_path)
        if size > max_bytes:
            raise OciError(
                f"{key!r} downloaded {size} bytes, exceeds cap of {max_bytes} bytes"
            )
        return tmp_path
    except Exception as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        if isinstance(exc, OciError):
            raise
        raise OciError(f"could not download {key!r}: {exc}") from exc


def fetch_log(run_id: str, key: str, max_bytes: int = DEFAULT_MAX_BYTES) -> bytes:
    """Download a single log object and return its bytes (small files / CLI use)."""
    path = fetch_log_to_path(run_id, key, max_bytes)
    try:
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def probe() -> dict:
    """Cheap availability check for /api/status. Never raises.

    Returns ``{available: bool, reason: str, profile?: str, hostname?: str}``.
    """
    if not os.environ.get("URSA_SDK_GRPC_AUTH_TOKEN"):
        return {
            "available": False,
            "reason": os.environ.get("BAG_READER_AUTH_HINT")
            or "no URSA token configured on the server",
        }
    try:
        _log_management()
    except OciError as exc:
        return {"available": False, "reason": str(exc)}
    return {
        "available": True,
        "reason": "",
        "profile": os.environ.get("AWS_PROFILE", ""),
        "hostname": os.environ.get("URSA_SDK_GRPC_HOSTNAME", ""),
    }
