# Deploying Log Reader (with OCI bag fetch) to apps-platform

The server holds ONE machine credential and fetches bags for anonymous users.
Deployment = give the container (a) `ursa-py` in the image, (b) machine creds so it
can mint a URSA token, (c) OCI bucket creds for downloads, then (d) gate who can
reach the URL. No per-user login.

Steps 1-2 handle credentials and must be run by you (you have echelon access; the
shared account does not). Nothing secret is committed to git.

> **Test the OCI path locally first:** run `make install-oci` then `./dev-oci.sh` to
> mint a token from your AWS SSO session and serve locally with bag fetch live. See the
> README's "Local dev with OCI bag fetch" section.

## Quick path (scripted)

Steps 1-2 (fetch creds + load them as secrets) are automated by `./setup-secrets.sh`,
and steps 3-4 (build + deploy) by `make ship`:

```
./setup-secrets.sh    # loads machine + OCI creds into apps-platform (needs your AWS SSO session)
URSA_PYPI_INDEX="https://<user>:<pass>@ursa.pypi.applied.dev/simple" make ship
```

`setup-secrets.sh` pulls machine creds from `echelon-machine-auth-local` and OCI creds
from your local `oci` AWS profile, then loads all six secrets via `apps-platform app
secret set` — values pass through a mode-600 temp file that's shredded on exit and never
print to screen. `make ship` runs `make image` (build with `ursa-py`) then `make deploy`.

The manual steps below explain what those two commands do; run them by hand if you need
to diverge (e.g. use dedicated service creds instead of your `oci` profile).

## 1. Fetch the creds (you run these; needs your default AWS SSO session)

Machine creds (mint the URSA token):
```
aws secretsmanager get-secret-value --secret-id echelon-machine-auth-local --region us-west-2 --query SecretString --output text
```
-> JSON with `CLIENT_ID`, `CLIENT_SECRET`.

OCI bucket creds (object downloads):
```
aws secretsmanager get-secret-value --secret-id offroad-oci-bucket-creds --region us-west-2 --query SecretString --output text
```
-> JSON with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL`.

> **Interim (shared creds still pending):** dedicated shared OCI service creds don't
> exist yet, and the `offroad-oci-bucket-creds` secret is a cloud/CI secret your account
> can't read. So for now the deploy uses **your** local `oci` AWS profile's creds — this
> is what `./setup-secrets.sh` reads (via `aws configure get ... --profile oci`). Swap in
> the dedicated service creds here once they're provisioned.

## 2. Set them as apps-platform secrets (become env vars in the container)

```
apps-platform app secret set CLIENT_ID            <from step 1>
apps-platform app secret set CLIENT_SECRET        <from step 1>
apps-platform app secret set AWS_ACCESS_KEY_ID    <from step 1>
apps-platform app secret set AWS_SECRET_ACCESS_KEY <from step 1>
apps-platform app secret set AWS_REGION           <from step 1>
apps-platform app secret set AWS_ENDPOINT_URL_S3  <AWS_ENDPOINT_URL from step 1>
```
(Tip: drop them in a local `.env` — gitignored — and `apps-platform app secret set --env .env`.
This is exactly what `./setup-secrets.sh` does, using a shredded temp file instead of `.env`.)

The server's `auth.py`: with `CLIENT_ID`/`CLIENT_SECRET` present it mints a token at
startup and refreshes it every 30 min. The `AWS_*` vars give the URSA SDK its OCI
object-storage credentials + endpoint.

## 3. Build the image with ursa-py (private index as a build secret, not in git)

```
URSA_PYPI_INDEX="https://<user>:<pass>@ursa.pypi.applied.dev/simple" make image
```
`make image` writes the index to a temp BuildKit secret and runs the `docker build`
for you. Equivalent by hand:
```
printf 'https://<user>:<pass>@ursa.pypi.applied.dev/simple' > /tmp/ursa_index
DOCKER_BUILDKIT=1 docker build --secret id=ursa_index,src=/tmp/ursa_index -t log-reader .
rm /tmp/ursa_index
```
(Without the secret the build still succeeds but is drag-drop-only.)

## 4. Deploy the locally-built image

```
make deploy       # wraps: apps-platform app deploy --image log-reader
```
(`project.toml` sets the service name `log-reader`. Omit `--image` to let Cloud Build
build remotely — but remote build can't see the private index, so build locally as
above and deploy the image. `make ship` runs steps 3 + 4 together.)

## 5. Verify

```
apps-platform app logs                 # look for "URSA OCI acquisition enabled"
curl -s https://<service-url>/api/status   # expect {"acquisition":"available",...}
```
Then load the site, paste a run-id / bag link, confirm it fetches + processes.

## 6. Gate who can reach it (this is how you "grant users access")

The server reads bags for ANYONE who can load the page, so do NOT leave it open to
the public internet. Put access control in front of the service (IAP / SSO / internal
network / allowlist) via apps-platform. Adding a user = adding them to that gate;
there is no AWS/login step for end users.

## Known risks to watch on first deploy (check `apps-platform app logs`)

- **Egress**: the container must reach `grpc.offroad.applied.dev` (URSA) and the OCI
  S3 endpoint. If fetches hang/fail with connection errors, egress needs opening.
- **OCI endpoint resolution**: the SDK must honor `AWS_ENDPOINT_URL_S3`. If downloads
  fail with an AWS/endpoint error, we may need to adjust how the endpoint is provided
  (mirror the local `oci` profile's `services = oci-s3-compat` block).
- **Token TTL**: if OCI works then breaks after a while, shorten `_TOKEN_REFRESH_SECONDS`
  in `auth.py`.
