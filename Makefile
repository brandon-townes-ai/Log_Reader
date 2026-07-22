.PHONY: install run dev deploy clean venv cli test

venv:
	test -d venv || python3 -m venv venv

install: venv
	./venv/bin/pip install -r requirements.txt

run: install
	./venv/bin/uvicorn src.server:app --host 0.0.0.0 --port 8000

dev: install
	./venv/bin/uvicorn src.server:app --reload --port 8000

deploy:
	apps-platform app deploy

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
