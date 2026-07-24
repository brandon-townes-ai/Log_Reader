# syntax=docker/dockerfile:1.4
FROM python:3.11-slim
WORKDIR /app

# Base deps (public PyPI) -- drag-drop + triage need only these.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# OCI/URSA bag fetch: install ursa-py from Applied's private index. The index URL
# (which contains credentials) is passed as a BuildKit *secret*, so it never lands
# in an image layer or in git. Build with:
#
#   printf 'https://<user>:<pass>@ursa.pypi.applied.dev/simple' > /tmp/ursa_index
#   DOCKER_BUILDKIT=1 docker build --secret id=ursa_index,src=/tmp/ursa_index -t log-reader .
#
# If the secret is absent, the step is skipped and the image is drag-drop-only.
COPY requirements-oci.txt .
RUN --mount=type=secret,id=ursa_index \
    if [ -s /run/secrets/ursa_index ]; then \
      pip install --no-cache-dir --extra-index-url "$(cat /run/secrets/ursa_index)" -r requirements-oci.txt; \
    else \
      echo "[build] no ursa_index secret -> building WITHOUT ursa-py (drag-drop only)"; \
    fi

COPY . .
CMD ["sh", "-c", "uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
