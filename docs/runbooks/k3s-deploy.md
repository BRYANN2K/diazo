# Runbook: the k3s instance on the VPS

How to deploy, check, roll back and repair the owner's Diazo instance. Read by Bryan and by agents operating it, often under time pressure.
Status: last run end to end 2026-11-12, passed (first deploy, recorded in the former `FORK.md`), updated 2026-11-16

Every command block ends with an `# Expect:` line. A result that differs means stop and go to Troubleshooting. Commands marked `# DESTRUCTIVE: ask Bryan first` are never run unprompted. Secret names only, never values.

## Purpose

- Runs: the owner's Diazo server and its Postgres, for Bryan and his agents. Users: Bryan; agents connected to its `/mcp`.
- Open this when: the first deploy on a new host, after a push to `staging` that should be tested, or when the instance stops answering.

## Architecture

`client → tailnet → tailscale serve :8850 (host bryann2k-infra) → svc/doop ClusterIP :4400 → deploy/doop → postgres-0`

- Manifests: `deploy/k3s/namespace.yaml`, `postgres.yaml`, `doop.yaml` (image `ghcr.io/bryann2k/diazo:staging`, `imagePullPolicy: Always`, `DOOP_INSTALL=kubernetes`, `DOOP_UPDATE_BRANCH=staging`, volume `doop-data` 5 Gi for `/app/data`, memory limit 2 Gi).
- URL (tailnet only): `https://bryann2k-infra-prod.tail35c61f.ts.net:8850`, MCP at `/mcp`.
- No ingress, no cloudflared, no Funnel ([ADR 0004](../adr/0004-expose-the-instance-over-tailscale-only.md)).

## Dependencies

| Depends on                             | Why                         | If it is down                                      |
| -------------------------------------- | --------------------------- | -------------------------------------------------- |
| `postgres-0` in ns `doop`              | all canvas and account data | the server fails its boot migrations and exits     |
| GHCR `ghcr.io/bryann2k/diazo` (public) | the image                   | a restart cannot pull; the running pod keeps going |
| Tailscale on the host                  | the only way in             | the instance is unreachable, but keeps running     |

## Access

```sh
tailscale status | grep bryann2k-infra
# Expect: the host listed, not "offline"
kubectl -n doop get pods
# Expect: postgres-0 and doop-… Running, READY 1/1
```

- Secret `doop-secrets` in ns `doop`, keys `POSTGRES_PASSWORD`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SIGNUP_EMAIL_DOMAINS`. It lives in the cluster only.

## Deploy

### First deploy on a host

```sh
df -h /
# Expect: at least 3 GB free
kubectl apply -f deploy/k3s/namespace.yaml
# Expect: namespace/doop created
DB_PASS=$(openssl rand -hex 16)
kubectl -n doop create secret generic doop-secrets \
  --from-literal=POSTGRES_PASSWORD="$DB_PASS" \
  --from-literal=DATABASE_URL="postgres://doop:$DB_PASS@postgres.doop.svc.cluster.local:5432/doop" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_URL="https://bryann2k-infra-prod.tail35c61f.ts.net:8850" \
  --from-literal=SIGNUP_EMAIL_DOMAINS=""
# Expect: secret/doop-secrets created. Signup is open: restrict SIGNUP_EMAIL_DOMAINS after the first account.
kubectl apply -f deploy/k3s/postgres.yaml -f deploy/k3s/doop.yaml
kubectl -n doop rollout status deploy/doop
# Expect: deployment "doop" successfully rolled out
tailscale serve --bg --https=8850 http://$(kubectl -n doop get svc doop -o jsonpath='{.spec.clusterIP}'):4400
# Expect: Serve started, tailnet only
```

### Update to the newest `staging` image

A push to `staging` builds `:staging` through `docker.yml`. The instance's admins see "Update available" once that build succeeds.

```sh
kubectl -n doop rollout restart deploy/doop && kubectl -n doop rollout status deploy/doop
# Expect: deployment "doop" successfully rolled out
```

## Validation

```sh
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/healthz
# Expect: 200
curl -sk -o /dev/null -w '%{http_code}\n' https://bryann2k-infra-prod.tail35c61f.ts.net:8850/mcp
# Expect: 405 (the MCP endpoint answers POST only)
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/api/version
# Expect: the commit of the image just pulled
```

## Rollback

1. Revert the bad commit on `staging` through a pull request, wait for `docker.yml`, then run the update above. Expect: `/api/version` names the previous good commit.
2. Pin a known image instead: set `image: ghcr.io/bryann2k/diazo:sha-<short>` in `deploy/k3s/doop.yaml` and `kubectl apply -f deploy/k3s/doop.yaml`. Expect: the rollout completes on that tag.
3. A bad migration that changed data needs a database restore. `# DESTRUCTIVE: ask Bryan first`

## Troubleshooting

### The pod cannot pull the image (`ErrImagePull`)

- Check: `kubectl -n doop describe pod -l app=doop | grep -i pull`. Expect: no `unauthorized`.
- Cause seen on the first deploy: the GHCR package was still private (GHCR's default). Fix: make `ghcr.io/bryann2k/diazo` public in the package settings. Fallback, import the image by hand:

```sh
docker build --platform linux/amd64 -t ghcr.io/bryann2k/diazo:staging .
docker save ghcr.io/bryann2k/diazo:staging | gzip > diazo-image.tar.gz
scp diazo-image.tar.gz <vps>:/tmp/
ssh <vps> 'sudo k3s ctr -n k8s.io images import /tmp/diazo-image.tar.gz'
# Expect: the image listed by `sudo k3s ctr -n k8s.io images ls | grep diazo`
```

### The pod restarts with OOMKilled during library curation

- Check: `kubectl -n doop get pod -l app=doop -o jsonpath='{.items[0].status.containerStatuses[0].lastState}'`. Expect: no `OOMKilled`.
- Fix: the limit was raised to 2 Gi for curation (`3efb6a83`). Raise it again in `doop.yaml` only if the host has the memory, then run Validation.

### Uploaded images vanish after a restart

- Check: `kubectl -n doop get pvc doop-data`. Expect: `Bound`.
- Fix: `/app/data` must be on the `doop-data` volume (`8b79e5d1`). Re-apply `doop.yaml`.
