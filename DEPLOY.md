# Deploying Log Reader (with OCI bag fetch) to apps-platform

The server holds ONE machine credential and fetches bags for anonymous users.
Deployment = give the container (a) `ursa-py` in the image, (b) machine creds so it
can mint a URSA token, (c) OCI bucket creds for downloads, then (d) gate who can
reach the URL. No per-user login.

Steps 1-2 handle credentials and must be run by you (you have echelon access; the
shared account does not). Nothing secret is committed to git.

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

## 2. Set them as apps-platform secrets (become env vars in the container)

```
apps-platform app secret set CLIENT_ID            <from step 1>
apps-platform app secret set CLIENT_SECRET        <from step 1>
apps-platform app secret set AWS_ACCESS_KEY_ID    <from step 1>
apps-platform app secret set AWS_SECRET_ACCESS_KEY <from step 1>
apps-platform app secret set AWS_REGION           <from step 1>
apps-platform app secret set AWS_ENDPOINT_URL_S3  <AWS_ENDPOINT_URL from step 1>
```
(Tip: drop them in a local `.env` — gitignored — and `apps-platform app secret set --env .env`.)

The server's `auth.py`: with `CLIENT_ID`/`CLIENT_SECRET` present it mints a token at
startup and refreshes it every 30 min. The `AWS_*` vars give the URSA SDK its OCI
object-storage credentials + endpoint.

## 3. Build the image with ursa-py (private index as a build secret, not in git)

```
printf 'https://<user>:<pass>@ursa.pypi.applied.dev/simple' > /tmp/ursa_index
DOCKER_BUILDKIT=1 docker build --secret id=ursa_index,src=/tmp/ursa_index -t log-reader .
rm /tmp/ursa_index
```
(Without the secret the build still succeeds but is drag-drop-only.)

## 4. Deploy the locally-built image

```
apps-platform app deploy --image log-reader
```
(`project.toml` sets the service name `log-reader`. Omit `--image` to let Cloud Build
build remotely — but remote build can't see the private index, so build locally as
above and deploy the image.)

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
