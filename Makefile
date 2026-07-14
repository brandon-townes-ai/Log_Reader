.PHONY: install install-oci run dev build image deploy ship clean venv cli test

TAG ?= latest

venv:
	test -d venv || python3 -m venv venv

install: venv
	./venv/bin/pip install -r requirements.txt

# Optional OCI/URSA bag fetch. ursa-py lives on Applied's private index; pass it
# via URSA_PYPI_INDEX so credentials never land in git, e.g.:
#   URSA_PYPI_INDEX="https://<user>:<pass>@ursa.pypi.applied.dev/simple" make install-oci
install-oci: install
	@test -n "$(URSA_PYPI_INDEX)" || { echo "set URSA_PYPI_INDEX=https://<user>:<pass>@ursa.pypi.applied.dev/simple"; exit 1; }
	./venv/bin/pip install --extra-index-url "$(URSA_PYPI_INDEX)" -r requirements-oci.txt

# Plain image (drag-drop only — no URSA creds baked in).
build:
	docker build -t log-reader:$(TAG) .

# OCI-enabled image with ursa-py baked in. The private index is passed as a
# BuildKit secret (never in git / image layers), so set URSA_PYPI_INDEX first:
#   URSA_PYPI_INDEX="https://<user>:<pass>@ursa.pypi.applied.dev/simple" make image
image:
	@test -n "$(URSA_PYPI_INDEX)" || { echo "set URSA_PYPI_INDEX=https://<user>:<pass>@ursa.pypi.applied.dev/simple"; exit 1; }
	@f=$$(mktemp); printf '%s' "$(URSA_PYPI_INDEX)" > "$$f"; \
	  DOCKER_BUILDKIT=1 docker build --secret id=ursa_index,src="$$f" -t log-reader:$(TAG) .; \
	  rc=$$?; rm -f "$$f"; exit $$rc

# Deploy the locally-built image (remote Cloud Build can't reach the private index).
deploy:
	apps-platform app deploy --image log-reader:$(TAG)

# Build the OCI-enabled image + deploy in one step.
ship: image deploy

run: install
	./venv/bin/uvicorn src.server:app --host 0.0.0.0 --port 8000

dev: install
	./venv/bin/uvicorn src.server:app --reload --port 8000

cli: install
	./venv/bin/python -m src.cli $(ARGS)

test: install
	./venv/bin/pip install -q -r requirements-dev.txt
	./venv/bin/python -m pytest tests/
	node --test tests/

clean:
	rm -rf venv
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
