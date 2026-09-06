# 워커 브리프 — SH-3b `scripts/oort` day-2: status · logs · upgrade · backup/restore · member (engine · SH-3a 후 · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `.github/**` 무접촉. `scripts/oort`·`scripts/lib/oort_*.sh`·`scripts/tests/` 만 수정/신규(정책 무결성 감사 대상 — 오케스트레이터가 감사). 기존 게이트·백업 스크립트 본체 무수정(재사용만). `schema_v0.sql` 무접촉. 볼륨 `rm` 금지.
> 근거: 편성 정본 §5 SH-3b(「업그레이드 1왕복 실측」) · SH-3a 랜딩(#1955: `scripts/oort doctor`, 나머지 5개는 stub `printf '… SH-3b에서'`) · `docs/SELF_HOST_AGENT.md` §1.7 멱등 재기동(Update 시 이미지 증발 전제 — bind 볼륨 재확인·`IDEMPOTENCY_OK` 게이트) · 백업 정본 `scripts/self_host_pg_dump.sh`/`self_host_pg_restore.sh`(공용 `scripts/lib/pg_dump_custom.sh` — 「다른 pg_restore 호출부를 만들지 마라」) · `scripts/verify_backup_restore_rehearsal.sh` · 릴리스 매니페스트 `releases/latest.json`(SH-1) · 초대·자격 REST(`routes/invites.rs`, agent credential 라우트 — **실사** 후 사용, 없으면 NOTES).

## 구현 계약
1. **`oort status [--env FILE] [--json]`**: doctor 라이브러리 재사용 — compose 서비스 health·`/healthz`·outbox 오라클·현재 이미지 digest(매니페스트와 비교: 최신/뒤처짐) 한 화면. 종료 코드 규칙은 doctor와 동일.
2. **`oort logs [service] [--since 10m] [--follow]`**: `docker compose logs` 래퍼 + **시크릿 마스킹**(env의 시크릿 키 값·Bearer 토큰·`postgres://…:…@` 비번을 `***`로; 키 목록은 `self_host_env.sh` 정본에서 파생).
3. **`oort upgrade [--to <ref@sha256:…>|--manifest URL|--local-build] [--yes]`**: §1.7을 코드로 — ①현재 digest·매니페스트 digest 비교(정규식 `^sha256:[0-9a-f]{64}$`, list≠arch) ②`oort backup` 자동 선행(`--no-backup`으로만 생략) ③bind 볼륨·env 존재 재확인(없으면 중단, 볼륨은 절대 만들지도 지우지도 않음) ④`compose pull`·`up -d` ⑤migrate 컨테이너 `IDEMPOTENCY_OK` 로그 대기 ⑥health 대기 ⑦`oort doctor` PASS ⑧요약(이전→이후 digest). 실패 시 이전 digest로 되돌리는 명령을 **인쇄**(자동 롤백은 하지 않는다 — 데이터 방향성).
4. **`oort backup [--out DIR]` / `oort restore <dump> [--yes]`**: 정본 두 스크립트를 호출만 한다(pg_dump/pg_restore 호출부 신설 금지). 산출물 이름에 버전·시각·digest 접미. restore는 **빈 스택**에만(기존 데이터 있으면 거부 + 안내).
5. **`oort member invite [--role member] [--expires 24h]` / `oort member credential --agent <handle> [--scopes …]`**: 운영자 세션 토큰(env 또는 `--token-file`)으로 REST 호출 — 라우트·요청 형식은 openapi에서 **실사**해 쓴다(추측 금지). 자격은 발급 즉시 한 번만 출력(재출력 없음), 시크릿은 로그·상태에 남기지 않는다.
6. 도움말·`docs/SELF_HOST.md` §막히면 표에 다섯 명령 1행씩, `docs/SELF_HOST_AGENT.md` §1.7은 「`scripts/oort upgrade`」 한 줄로 교체(절차 산문은 남기되 명령이 정본).

## red proof (선행 커밋)
- 자체 하네스(`scripts/tests/test_oort_day2.sh`, bats 있으면 bats): `upgrade`가 digest 형식 오류·볼륨 부재·env 부재에서 **중단**(3케이스) · `restore`가 비어 있지 않은 스택을 거부 · `logs` 출력에 픽스처 시크릿 0건(grep 게이트) · `status --json` 스키마.
- **업그레이드 1왕복 실측**(로컬 스택, published-image 모드): 메시지 N건 적재 → `oort backup` → `oort upgrade --to <같은 digest 또는 매니페스트>` → doctor PASS → 메시지 N건 동일 → `oort restore`를 **새 빈 스택**에 → N건 동일. 숫자·digest를 PR 본문에.

## 완료 절차
`bash -n`·shellcheck(있으면)·자체 테스트 그린 → 왕복 실측 첨부(시크릿 마스킹 확인) → 커밋(RED 선행) → `git push -u origin feat/sh3b-oort-day2` → `gh pr create --base track/engine` → 정지.

## 규율
정본 재사용(doctor 라이브러리·pg_dump 라이브러리·매니페스트) — 사본 금지. 자동 롤백·볼륨 조작·시크릿 출력 금지. 막히면 우회 말고 보고 후 정지.
