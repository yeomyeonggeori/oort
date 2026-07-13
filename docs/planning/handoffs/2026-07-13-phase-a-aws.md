# Handoff Packet — Phase A: AWS 10인 내부 알파 배포 준비 (MOMO-360/361)

- Status: **active** (2026-07-13, momo-main/Fable · 성재 확정: 단일 EC2 t4g.large 실배포, CI/CD는 GH Actions pull&up — 무중단 배포는 명시적 non-goal)
- 정본: `docs/AWS_INTERNAL_ALPHA.md`(토폴로지/비용/보안/배포 절차), `infra/prod/`(compose.prod, Caddyfile, centrifugo, pgbackrest, preflight 스크립트 기존재).
- 경계: 이 배치는 **repo 아티팩트와 runbook**만 만든다. 실제 AWS 리소스 생성·secrets 주입·도메인 연결은 성재+오케스트레이터의 운영 단계다. worker는 AWS API를 호출하지 않는다.

## MOMO-360 — GHCR 이미지 발행 워크플로 + pull&up 배포 계약 `[infra/tooling]`

문제: `docs/AWS_INTERNAL_ALPHA.md` §7이 요구하는 "빌더에서 이미지 빌드 → 불변 태그 push → 호스트는 pull&up"에서 이미지 발행 파이프라인이 없다(`ci-build.yml`은 macOS 빌드 검증 전용, workflow_dispatch only).
방향:
1. `.github/workflows/publish-images.yml` — **workflow_dispatch 전용**(자동 트리거 금지 — repo는 GH Actions 자동 실행을 의도적으로 꺼둔 상태). api/relay/worker/migrate 4개 이미지를 `infra/prod/docker/swift-service.Dockerfile` 기반으로 빌드해 `ghcr.io/dawn-kim-official/momo-*:sha-<gitsha>` 불변 태그로 push. linux/arm64 필수(t4g=Graviton), buildx.
2. `infra/prod/docker-compose.prod.yml`이 이미지 태그를 env(`MOMO_IMAGE_TAG`)로 주입받는 계약 확인/보강 + 롤백 = 이전 digest로 같은 명령 재실행임을 compose 주석·runbook에 고정.
3. 정적 검증: `actionlint`(또는 `bash -n` 수준의 YAML 검증 대안), `docker compose -f … config` dry-run PASS. **이미지 실빌드/push는 하지 않는다**(로컬 Docker 금지 — 검증은 구문·계약 수준).
4. `scripts/aws_internal_alpha_preflight.sh` evidence 계약과 충돌하지 않게 env example에 이미지 태그 키 추가.

## MOMO-361 — 배포 번들 패커 + 10인 알파 운영 runbook `[docs/tooling]`

문제: §7 3단계 "호스트에는 deploy bundle만 복사"가 수동 나열 상태고, 10인 온보딩(초대 코드→앱 접속→Hermes 사용) 운영 절차가 문서화되어 있지 않다.
방향:
1. `scripts/make_deploy_bundle.sh` — compose/Caddyfile/centrifugo config/env template/runbook만 tar로 패키징(소스 체크아웃 없음 보장, secrets/`.env` 실값 포함 시 fail-closed). `bash -n`+shellcheck+합성 fixture 테스트.
2. `docs/runbooks/aws-internal-alpha-deploy.md` — provision(EIP/gp3/SG) → preflight 2종 → bundle 반입 → pull&up → 헬스 verify → 롤백 절차를 실행 커맨드 단위로. `AWS_READY` 게이트 표(§0) 충족 확인 단계 포함.
3. `docs/runbooks/internal-alpha-onboarding.md` — 운영자(성재) 관점: 워크스페이스/채널 2+ 생성 → 인원별 invite 코드 발급(`InviteRoutes` 기존 REST) → 앱 배포 채널 안내 → Hermes 사용 규칙(승인 왕복 포함) 1페이지.
4. 명시적 non-goal: 무중단 배포, split 토폴로지, iOS.

## 검수·머지 절차 (오케스트레이터)

worker PR → 정적 검증 검수(actionlint/shellcheck/compose config) → clean gate(전 프로파일 무회귀 확인) → 순차 merge → root gate. 이후 운영 단계(성재와 함께): GHCR publish 1회 실행 → EC2 provision → runbook 따라 배포 → 10인 초대.
