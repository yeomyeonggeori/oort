# AWS Internal Alpha Stack v0

> Scope: one-week team alpha host for Caddy, MomoServer API, OutboxRelay,
> AgentWorker, Centrifugo, Redis, and PostgreSQL. This is not the M7 release
> gate and not a production launch. Actual AWS host creation, DNS propagation,
> TLS issuance, registry pull, SOPS decrypt, pgBackRest backup, and PITR restore
> rehearsal remain `runtime-unverified(aws-host)` until performed on AWS.

## 0. Decision

Use **EC2 recommended single-node** for the first one-week internal alpha:
`t4g.large` in `us-east-1`, one Elastic IP, encrypted `gp3` data volume, Caddy
on 80/443, all oort services in image-based Docker Compose, pgBackRest to S3,
and daily EBS snapshots.

Do not provision this host until the local one-person alpha handoff in
[`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md) or the 72-hour contract in
[`docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`](LOCAL_3_DAY_ALPHA_TEST_PACK.md) is
marked `AWS_READY`. The promotion threshold is:

| Gate | Required before AWS |
|---|---|
| Local gate | One-person local alpha checklist PASS with login, channel load, message send/receive, invite/join, Kim Intern mention, restart/reconnect, diagnostics, and feedback evidence. |
| 1인 soak | At least 5 local sessions across at least 2 calendar days and at least 120 active minutes, including app and server/relay/Centrifugo restart coverage. |
| External agent runtime smoke | Credentialed `AGENT_PROVIDER_MODE=external-hermes` roundtrip through local MomoServer, AgentWorker, OutboxRelay, and durable timeline. A no-credential skip blocks AWS. |
| No P0/P1 | Zero open P0/P1 feedback items after triage. |
| Diagnostics | Final redacted diagnostics bundle references the same commit and local gate evidence. |

If any row is missing, the decision is `NEEDS_MORE_LOCAL` or `BLOCKED`; keep
this document as planning material and do not create AWS resources.

Lightsail is cheaper and faster to click together, but EC2 is the better v0
default because it matches the controls this repo is already preflighting:
security groups, IAM instance profile, encrypted EBS volumes, EBS snapshot
restore drills, S3 backup repository, and a clean path to a split DB host.

Run the topology preflight before provisioning or handoff:

```bash
scripts/aws_internal_alpha_preflight.sh \
  --env-file infra/prod/aws-internal-alpha.env.example \
  --mode recommended \
  --evidence-dir /tmp/momo-aws-alpha-preflight
```

For a real host, copy the fixture to an untracked file such as
`/run/momo/aws-alpha.env`, replace domains/CIDRs/IAM/bucket/images, then rerun
the same command against that file. The preflight checks intent only; it does
not call AWS APIs.

## 1. Topologies

### Minimum

Single node, all services on one host.

| Item | EC2 minimum | Lightsail minimum |
|---|---|---|
| Host | `t4g.medium` Linux | Linux/Unix general purpose 4 GB bundle |
| Services | Caddy/API/relay/worker/Centrifugo/Redis/Postgres | same |
| Storage | 30 GB root + 80 GB encrypted gp3 data | bundled SSD, snapshot enabled |
| Use when | <=10 testers, low message volume, external Hermes only | fastest throwaway alpha |
| Risk | 4 GiB RAM can get tight during worker spikes | weaker VPC/IAM/EBS restore fidelity |

### Recommended

Single EC2 node, enough headroom for a week of team use.

```text
Internet
  -> Elastic IP / A records
  -> EC2 t4g.large
       Caddy :80/:443
       api:8080, centrifugo:8000, redis:6379, postgres:5432 on Docker network only
       OutboxRelay + AgentWorker as compose services
       /srv/momo Docker data root on encrypted gp3 data volume
       pgBackRest WAL/full backup to S3 + daily EBS snapshot
```

This is the v0 recommendation. It keeps operations simple while preserving the
real deploy boundary: pinned images, no source checkout on host, SOPS/host env
secrets, Caddy TLS, Redis-backed Centrifugo, Postgres as SoT.

### Split

Two EC2 nodes when we need DB isolation or a more realistic restore drill.

| Node | Instance | Public? | Services |
|---|---|---|---|
| `app` | `t4g.medium` | yes, 80/443 only | Caddy, API, OutboxRelay, AgentWorker, Centrifugo, Redis |
| `db` | `t4g.large` | no | PostgreSQL 18, pgBackRest |

Only the DB security group allows `5432` from the app security group. Redis
stays on the app node for v0 because Centrifugo is the only consumer and Redis
is transport state, not SoT.

## 2. Lightsail vs EC2

| Dimension | Lightsail | EC2 |
|---|---|---|
| v0 cost | Lower fixed bundle price | Slightly higher once EBS + IPv4 are counted |
| Setup speed | Fastest manual setup | More moving pieces |
| Security control | Lightsail firewall/static IP | VPC security groups, IAM instance profile, IMDSv2 |
| Backup/restore | Instance snapshots are simple | EBS snapshots, volume replacement, pgBackRest to S3 |
| Image deploy | Works with Docker Compose | Works with Docker Compose and ECR/GHCR IAM patterns |
| Scale-out path | Limited | Natural split app/db topology |
| Recommendation | Only for disposable demos | **Use for MOMO-233 internal alpha** |

## 3. Cost Estimate

Checked 2026-07-01. Region assumption is `us-east-1`, Linux, 730 hours/month,
no NAT Gateway, no load balancer, no paid CloudWatch log retention, and low
egress. Recheck with AWS Pricing Calculator before purchase.

Official pricing anchors:

- Lightsail Linux/Unix bundles: 4 GB `$24/mo`, 8 GB `$44/mo`, 16 GB `$84/mo`;
  Lightsail snapshots `$0.05/GB-mo`.
- EC2 On-Demand public price list lookup for `us-east-1`: `t4g.medium`
  `$0.0336/hr` (`$24.53/mo`), `t4g.large` `$0.0672/hr` (`$49.06/mo`),
  `t4g.xlarge` `$0.1344/hr` (`$98.11/mo`).
- EBS gp3 baseline storage: `$0.08/GB-mo`.
- Public IPv4: `$0.005/hr` (`$3.60/mo` at 30 days).
- Route 53 hosted zone: `$0.50/mo` for the first 25 zones.
- S3 Standard first 50 TB in `us-east-1`: `$0.023/GB-mo`.

| Topology | Monthly estimate | One-week estimate | Notes |
|---|---:|---:|---|
| Lightsail minimum 4 GB | `$26-$28` | `$7-$8` | `$24` bundle + snapshot usage. Tight RAM. |
| Lightsail recommended 8 GB | `$48-$52` | `$12-$14` | `$44` bundle + snapshots. Fastest disposable host. |
| EC2 minimum `t4g.medium` | `~$39` | `~$9-$10` | Compute `$24.53`, 110 GB gp3 `$8.80`, IPv4 `$3.60`, small backup/DNS. |
| EC2 recommended `t4g.large` | `~$69` | `~$16-$18` | Compute `$49.06`, 150 GB gp3 `$12`, IPv4 `$3.60`, S3/snapshots/DNS. |
| EC2 split app/db | `~$106` | `~$25-$28` | `t4g.medium + t4g.large`, 260 GB gp3, one public IPv4, larger backup set. |

The one-week estimate prorates compute/storage/IP roughly by time. Route 53
hosted zones are not prorated if a new zone is created, and real egress or log
retention can add cost.

## 4. Security Groups

### Single-node EC2

| Direction | Port | Source/destination | Rule |
|---|---:|---|---|
| inbound | 22 | operator VPN/office `/32` or SSM-only | No `0.0.0.0/0` SSH. Prefer Session Manager. |
| inbound | 80 | `0.0.0.0/0`, `::/0` only for Caddy HTTP-01 | If using DNS-01, close 80. |
| inbound | 443 | tester CIDRs, or `0.0.0.0/0` for dynamic testers | Only Caddy exposed. |
| inbound | 5432/6379/8000/8080 | none | Postgres/Redis/Centrifugo/API direct ports stay Docker-internal. |
| outbound | 443 | internet | registry pull, S3, SOPS/KMS if used, Hermes. |
| outbound | 53/123 | VPC resolver/time | DNS and time sync. |

### Split EC2

`app-sg` has the public 80/443 rules above. `db-sg` has no public ingress and
only allows `5432/tcp` from `app-sg`. The DB node has no public IP. SSH/SSM is
operator-only on both nodes.

Other hardening:

- Require IMDSv2.
- Use an IAM instance profile with only ECR/GHCR-equivalent pull, S3 backup
  bucket access, CloudWatch log write if enabled, and SSM if used.
- Store production-like secrets in SOPS or a root-owned tmpfs env file. Do not
  put passwords or long-lived keys in user data.

## 5. DNS/TLS

Create:

- `alpha-api.<domain>` -> alpha host Elastic IP/static IP
- `alpha-rt.<domain>` -> same host

Caddy terminates TLS and routes API and realtime separately. `rt` proxies only
to Centrifugo. Centrifugo subscribe proxy remains internal:
`http://api:8080/v1/centrifugo/subscribe`.

Use Caddy HTTP-01 for the fastest alpha if 80 can be open. Use Caddy DNS-01
when 80 must remain closed or when the tester allowlist cannot expose HTTP.

## 6. Volumes, Backup, Recovery

Recommended EC2 volume layout:

| Mount | Size | Purpose |
|---|---:|---|
| root | 30 GB gp3 encrypted | OS, Docker engine, deploy bundle |
| `/srv/momo` | 120 GB gp3 encrypted | Docker data root or compose volume root |

Set Docker `data-root` to `/srv/momo/docker` before first compose boot so named
volumes for Postgres/Redis/Caddy live on the encrypted data volume.

Backup layers:

1. pgBackRest full backup before opening alpha, nightly full/incremental during
   alpha, WAL archive to S3.
2. Daily EBS snapshot of the data volume with 7-day retention and one final
   snapshot after alpha shutdown.
3. Repo-local `scripts/local_gate.sh --profile backup` remains useful but is
   not AWS proof. Host handoff needs a real restore rehearsal.

Recovery targets:

| Failure | Recovery |
|---|---|
| Bad app image | Roll back to previous image digest and run `docker compose up -d --no-build`. |
| Host corruption | Launch replacement host, attach volume from latest snapshot, run preflight, then compose up. |
| DB logical corruption | Restore pgBackRest to a new volume/host and repoint Elastic IP/DNS after verification. |
| Region/account mistake | Out of v0 scope; take final snapshot/export and rebuild manually. |

Do not destructively restore over the only alpha volume. Restore into a new
volume or replacement host, verify `/health`, login, message send, relay
publish, and Kim Intern mode, then switch traffic.

## 7. Image-Based Deploy

The alpha host must not need a source checkout.

1. Build the multi-command oort image on a builder machine or CI.
2. Push one immutable tag or digest to GHCR/ECR, for example
   `ghcr.io/dawn-kim-official/momo:sha-<gitsha>`.
   The manual-only `publish-images` workflow publishes the `api`, `relay`,
   `worker`, `migrate`, `web-assets`, and `linkshort` payload for `linux/arm64`
   under one `MOMO_IMAGE_TAG=sha-<40-char-gitsha>`.
3. Copy only a deploy bundle to the host: compose files, Caddyfile,
   Centrifugo config, env template, and operator runbook.
4. Run preflight:

```bash
scripts/aws_internal_alpha_preflight.sh --env-file /run/momo/aws-alpha.env --mode recommended
scripts/prod_env_preflight.sh --env-file /run/momo/prod.env --mode internal-host
```

5. Pull and start without build:

```bash
docker compose -f infra/prod/docker-compose.prod.yml pull
docker compose -f infra/prod/docker-compose.prod.yml up -d --no-build
```

Rollback is the same command after restoring the previous `MOMO_IMAGE_TAG`
derived refs, or the four previous per-image digests. The one-shot migrate image
runs before API/relay/worker, so database migrations must remain
forward-compatible for the alpha window; otherwise restore a new DB volume from
snapshot/PITR.

## 8. Preflight Evidence

`scripts/local_gate.sh --profile docs` runs the AWS fixture preflight and writes
redacted evidence under the local gate output directory. This proves only the
documented shape. For a real host, attach:

- `AWS_READY` one-person alpha handoff from `docs/INTERNAL_ALPHA.md` or
  `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`
- `aws-internal-alpha-preflight-<topology>.md/json`
- `prod-env-preflight-internal-host.md/json`
- image digest list
- DNS records and TLS issuance timestamp
- first pgBackRest backup/check output
- restore rehearsal target host/volume and verification query
- deploy and rollback command transcript with secrets redacted

## 9. Sources Checked

- AWS Lightsail pricing: <https://aws.amazon.com/lightsail/pricing/>
- AWS EC2 On-Demand pricing and AWS public price list:
  <https://aws.amazon.com/ec2/pricing/on-demand/>,
  <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json>
- AWS EBS pricing and snapshots: <https://aws.amazon.com/ebs/pricing/>
- AWS VPC public IPv4 pricing: <https://aws.amazon.com/vpc/pricing/>
- AWS Route 53 pricing: <https://aws.amazon.com/route53/pricing/>
- AWS VPC security groups: <https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html>
- AWS EBS snapshot create/restore docs:
  <https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-snapshot.html>,
  <https://docs.aws.amazon.com/ebs/latest/userguide/ebs-restoring-volume.html>
