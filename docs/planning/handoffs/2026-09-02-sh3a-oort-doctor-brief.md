# 워커 브리프 — SH-3a `scripts/oort doctor` — 셀프호스트 설치 판정 1개 (engine · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `.github/**` 무접촉. 신규 `scripts/oort`(bash) + `scripts/lib/oort_doctor.sh` 만 추가, 기존 게이트 스크립트 무수정(정책 감사 대상 — 오케스트레이터가 감사). compose·env 파일은 **읽기만**.
> 근거: 편성 정본 §5 SH-3a · 셀프호스팅 실사 갭 ⑦(조용히 죽는 env 키: `MOMO_DOORBELL_ENABLED`/`MOMO_HOSTED_DELIVERY_ENABLED`/`MOMO_UNFURL_ENABLED`는 소문자 `true`만, `PLATFORM_ADMIN_EMAILS` 누락=AI 연결 403, `PROVIDER_LINK_MASTER_KEY` 누락=503, `MOMO_DRIVE_ARCHIVE_BACKEND` 공백=첨부 503, api·webhook-sender가 플래그를 각각 읽음)·갭 ⑩(검증 130본이 판정 1개로 합성 안 됨). 재료: `scripts/self_host_env.sh`(env 생성·검증 규칙 — 함수 재사용 가능 여부 실사), `scripts/bench_onboarding.sh` M1~M3, `scripts/collect_diagnostics.sh`, `docs/SELF_HOST.md` §막히면 표, `infra/rust/README.md` 문제 해결 절.

## 구현 계약
1. **`scripts/oort`** = 서브커맨드 디스패처(bash 3.2 호환, `set -euo pipefail`). 이 티켓은 `doctor`만 구현하고 `status/logs/upgrade/backup/member`는 "SH-3b에서"라는 도움말 stub.
2. **`oort doctor [--env <file>] [--json] [--strict]`** 검사 항목(각각 `id·severity(blocker/major/minor)·status(pass/fail/skip)·detail·fix`):
   - 도구: docker·compose v2·jq·openssl 존재/버전 · 디스크 여유 · 포트 충돌(env의 포트 실측)
   - env 파일: 존재·0600·중복 키·단일행 스칼라 · **필수 키 전수**(생성기가 쓰는 키 목록을 `self_host_env.sh`에서 추출해 하드코딩 금지) · 소문자-`true` 게이트 3종의 오표기(`True/1/yes`) 적발 · `PLATFORM_ADMIN_EMAILS`·`PROVIDER_LINK_MASTER_KEY`·`MOMO_DRIVE_ARCHIVE_BACKEND`·`MOMO_CENTRIFUGO_WS_URL` 존재 · 4중 교차값(role 비번↔DATABASE_URL) 일치 · digest 형식(published-image 모드)
   - 스택: `docker compose ps` 서비스별 health · `/healthz` 200+`database:ok` · agent-port 무인증 401+`WWW-Authenticate: Bearer scope="agent:port:connect"` · outbox 오라클(`SELECT kind,status,count(*) FROM outbox GROUP BY 1,2` — `broadcast|done` 외 잔량 경고) · migrate 컨테이너 `IDEMPOTENCY_OK` 로그
   - 공개 오리진 모드(`--public-origin` 흔적): 외부 `/healthz` 200 + WS 업그레이드 101(curl) — 없으면 skip 명시
   - 시크릿은 **절대 출력하지 않는다**(키 이름·길이·형식 판정만).
3. 출력: 사람용 표(기본) + `--json`(`{summary:{pass,fail,skip,verdict:PASS|FAIL}, checks:[…]}`), 종료 코드 = blocker fail 있으면 2, major만이면 1, 아니면 0. `--strict`는 major도 2.
4. 문서: `docs/SELF_HOST.md` §막히면 표 맨 위에 "먼저 `scripts/oort doctor`" 1행, `infra/rust/README.md` 동일. (영문화는 SH-4.)

## red proof (선행 커밋)
- 픽스처 env(스크래치)에서 `MOMO_DOORBELL_ENABLED=True` → fail(major, fix 문구에 소문자 안내) · `PLATFORM_ADMIN_EMAILS` 삭제 → fail(blocker) · role 비번↔DATABASE_URL 불일치 → fail(blocker) · 정상 env → PASS. 시크릿 값이 출력에 0건(grep 게이트).
- 스택 미기동 상태에서 스택 검사가 fail이 아니라 skip+안내(설치 전 preflight 용도 성립).
- `bats`가 있으면 bats, 없으면 `scripts/tests/test_oort_doctor.sh` 자체 하네스.

## 완료 절차
`bash -n`·shellcheck(있으면)·자체 테스트 그린 → 로컬 스택(oortv013 등 기동 중이면 그것)에서 `scripts/oort doctor --json` 1회 실측 결과를 PR 본문에 첨부(시크릿 마스킹 확인) → 커밋 → `git push -u origin feat/sh3a-oort-doctor` → `gh pr create --base track/engine` → 정지.

## 규율
키 목록·규칙은 `self_host_env.sh`에서 파생(이중 정본 금지). 막히면 우회 말고 보고 후 정지.
