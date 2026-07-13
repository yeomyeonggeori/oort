# AWS 10인 내부 알파 배포 runbook

> 대상: 운영자(성재) · 토폴로지: EC2 `t4g.large`, `us-east-1`, 단일 노드.
> 이 문서는 AWS 리소스를 자동 생성하지 않는다. 실제 AWS/DNS/TLS/registry/backup
> 검증은 완료 전까지 `runtime-unverified(aws-host)`다.

## 0. 배포 전 `AWS_READY` 게이트

먼저 repo 정본 `docs/AWS_INTERNAL_ALPHA.md` §0의 아래 다섯 행을
같은 커밋의 evidence로 확인한다. 한 행이라도 빠지면 `NEEDS_MORE_LOCAL` 또는
`BLOCKED`로 기록하고 AWS 리소스를 만들지 않는다.

| 확인 | 필수 evidence |
|---|---|
| [ ] Local gate | login, channel load, send/receive, invite/join, Hermes mention, restart/reconnect, diagnostics, feedback PASS |
| [ ] 1인 soak | 2일 이상·5세션 이상·active 120분 이상 |
| [ ] External agent runtime smoke | credentialed `external-hermes` durable roundtrip PASS; credential skip은 불가 |
| [ ] No P0/P1 | triage 후 open P0/P1 0개 |
| [ ] Diagnostics | 같은 commit/local evidence를 가리키는 redacted bundle |

결정값이 `AWS_READY`인지 확인하고 배포 커밋을 고정한다.

```bash
export MOMO_DEPLOY_SHA='<40-character git SHA>'
test "$(printf '%s' "$MOMO_DEPLOY_SHA" | wc -c | tr -d ' ')" -eq 40
```

## 1. EC2 provision (수동)

AWS Console에서 API 자동화 없이 다음 값으로 생성한다.

1. `us-east-1`의 arm64 Linux EC2 `t4g.large`, IMDSv2 required, IAM instance
   profile `momo-alpha-host`, 30 GiB encrypted gp3 root를 만든다.
2. 120 GiB encrypted gp3 data volume을 같은 AZ에 만들고 연결한다. Elastic IP
   하나를 할당·연결한다.
3. Security Group inbound는 80/443(테스터 정책에 맞는 CIDR), 22(운영자
   VPN/고정 IP)만 허용한다. PostgreSQL 5432, Redis 6379, Centrifugo 8000,
   API 8080은 열지 않는다. outbound 443을 허용한다.
4. API/realtime DNS A 레코드를 Elastic IP로 연결한다. Caddy HTTP-01이면 80을
   유지한다.

호스트에 접속한 뒤 data volume을 `/srv/momo`에 마운트하고 Docker data-root를
첫 compose 기동 전에 옮긴다. 장치명은 Console의 실제 attachment를 확인해
대입한다.

```bash
lsblk -f
sudo mkfs.ext4 /dev/nvme1n1                 # 새 빈 volume에서만 1회
sudo install -d -m 0755 /srv/momo
sudo mount /dev/nvme1n1 /srv/momo
findmnt /srv/momo
sudo install -d -m 0711 /srv/momo/docker
printf '%s\n' '{"data-root":"/srv/momo/docker"}' | sudo tee /etc/docker/daemon.json >/dev/null
sudo systemctl restart docker
docker info --format '{{.DockerRootDir}}'
```

재부팅 후에도 mount되도록 UUID 기반 `/etc/fstab`을 설정하고 `sudo mount -a`를
검증한다. OS 패키지 설치·SSH hardening은 조직 표준을 따른다.

## 2. 두 preflight와 번들 생성 (운영자 workstation)

실제 값은 repo 밖 mode 600 파일에만 둔다. 아래 명령은 intent를 검사할 뿐 AWS
API, Docker, registry를 호출하지 않는다.

```bash
install -d -m 0700 "$HOME/.momo/aws-alpha"
install -m 0600 infra/prod/aws-internal-alpha.env.example "$HOME/.momo/aws-alpha/topology.env"
install -m 0600 infra/prod/secrets.env.example "$HOME/.momo/aws-alpha/prod.env"
# 두 파일의 placeholder를 실제 domain/CIDR/image digest/secret로 편집한다.

EVIDENCE_DIR="$HOME/.momo/aws-alpha/evidence-$MOMO_DEPLOY_SHA"
scripts/aws_internal_alpha_preflight.sh \
  --env-file "$HOME/.momo/aws-alpha/topology.env" \
  --mode recommended \
  --evidence-dir "$EVIDENCE_DIR"
scripts/prod_env_preflight.sh \
  --env-file "$HOME/.momo/aws-alpha/prod.env" \
  --mode internal-host \
  --evidence-dir "$EVIDENCE_DIR"
```

두 preflight가 PASS한 뒤 source-checkout-free 번들을 만든다. 번들은 secret 실값을
담지 않는다.

```bash
scripts/make_deploy_bundle.sh \
  --output "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz"
tar -tzf "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz"
shasum -a 256 "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz" \
  > "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz.sha256"
```

archive 목록에는 `momo-deploy/` 아래 compose, Caddyfile, Centrifugo config,
두 env **template**, 두 runbook만 있어야 한다. `.env`, source, Dockerfile,
private key가 보이면 중단한다.

## 3. 번들·secret 반입

번들과 checksum은 일반 SCP로, 실제 prod env는 별도 승인된 secret 전달 경로로
보낸다. 채팅·티켓·shell history에 secret 값을 붙이지 않는다.

```bash
scp "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz" \
  "/tmp/momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz.sha256" \
  momo-alpha:/tmp/
ssh momo-alpha 'sudo install -d -m 0755 /opt/momo/releases /opt/momo/current; sudo install -d -m 0700 /run/momo'
```

호스트에서 checksum을 확인하고 고정 release 디렉터리에 푼다.

```bash
export MOMO_DEPLOY_SHA='<same 40-character git SHA>'
cd /tmp
sha256sum -c "momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz.sha256"
sudo install -d -m 0755 "/opt/momo/releases/${MOMO_DEPLOY_SHA}"
sudo tar -xzf "momo-deploy-${MOMO_DEPLOY_SHA}.tar.gz" \
  -C "/opt/momo/releases/${MOMO_DEPLOY_SHA}"
sudo ln -sfn "/opt/momo/releases/${MOMO_DEPLOY_SHA}/momo-deploy" /opt/momo/current/momo-deploy
```

secret 전달 도구가 만든 host-local 파일을 `/run/momo/prod.env`로 설치한다.

```bash
sudo install -o root -g root -m 0600 /path/from/approved-secret-channel/prod.env /run/momo/prod.env
sudo test -s /run/momo/prod.env
```

## 4. GHCR pull, migration, up

read-only package token은 stdin으로만 전달한다. 자동 build는 금지한다.

```bash
read -rsp 'GHCR read token: ' GHCR_READ_TOKEN; echo
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u '<github-user>' --password-stdin
unset GHCR_READ_TOKEN

cd /opt/momo/current/momo-deploy
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml config --services
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml config --images
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml pull
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml up -d postgres redis centrifugo
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml run --rm migrate
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml up -d --no-build --wait
```

`config --services`에 `api`, `relay`, `worker`, `migrate`가 모두 없거나 image가
`sha-<gitsha>`/digest로 고정되지 않았으면 중단한다. migration 실패 시 app을
기동하지 않는다.

## 5. verify와 evidence

```bash
export API_DOMAIN='<deployed API domain>'
export REALTIME_DOMAIN='<deployed realtime domain>'
cd /opt/momo/current/momo-deploy
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml ps
curl -fsS "https://${API_DOMAIN}/health" | jq .
curl -fsS "https://${REALTIME_DOMAIN}/health" | jq .
docker inspect "$(docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml ps -q api)" \
  --format '{{.Image}}'
```

앱에서 owner login → 두 public channel load → 메시지 송수신 → invite/join →
Hermes mention → approval approve/reject 왕복을 확인한다. pgBackRest 첫 backup/check,
새 volume/host 대상 restore rehearsal, EBS snapshot도 완료한다. transcript에는 secret,
bearer, DB URL을 포함하지 말고 §2 preflight evidence·image digest·DNS/TLS 시각·backup/
restore 결과·배포 커밋을 함께 보관한다.

## 6. 롤백

배포 전에 이전 `/run/momo/prod.env`와 image digest 목록을 mode 600으로 보존한다.
애플리케이션 회귀는 이전 digest로 되돌린 뒤 같은 pull/up을 실행한다.

```bash
sudo cp -p /run/momo/prod.env /run/momo/prod.env.failed
sudo install -o root -g root -m 0600 /run/momo/prod.env.previous /run/momo/prod.env
cd /opt/momo/current/momo-deploy
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml pull
docker compose --env-file /run/momo/prod.env -f docker-compose.prod.yml up -d --no-build --wait
curl -fsS "https://${API_DOMAIN}/health" | jq .
```

DB migration이 이전 image와 호환되지 않으면 유일한 volume 위에 덮어쓰지 않는다.
snapshot/PITR를 **새 volume 또는 replacement host**에 복원해 검증한 뒤 Elastic IP/DNS를
전환한다.

## Non-goals

- 무중단/blue-green 배포와 자동 rollback
- app/DB split 토폴로지 및 Kubernetes
- iOS 배포
- 이 runbook 또는 repo script에 의한 AWS API 호출
