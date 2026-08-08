# 실배포 리허설 Phase 1 보고서 (2026-07-23, momo-main) — **PASS**

> 정의: `2026-07-22-opensource-release-package.md` §6 Phase 1(로컬) — 배포 번들·install 경로·호스팅 스모크·백업/복원을 오케스트레이터가 일괄 실행. **이 PASS가 공개 릴리스 게이트의 리허설 조건을 충족한다**(잔여 전제: MOMO-564 README/SECURITY).
> 검증 기준 상태: main `98a1352` — Wave H 전량(554~563)+565(단일 이미지) 랜딩 후의 최종 배포 형상.

## 결과 (5/5 PASS)

| 항목 | 결과 | 증거 |
|---|---|---|
| ① 정적 게이트 전체(docs 프로파일 — 브랜치스큐·마이그레이션 중복·SPM 라이선스 37deps·번들 픽스처 포함) | PASS | local-gate evidence(sha256 매니페스트 포함) |
| ② 배포 번들 실생성 | PASS | `make_deploy_bundle.sh` — compose/Caddyfile/centrifugo/env 템플릿/런북만 포함, 소스·시크릿 미포함 확인 |
| ③ prod RLS 태세 실런 | PASS | `verify_prod_rls_posture.sh`(28170~28173) — API=momo_app, 교차 ws 0행, 카탈로그 쓰기 거부, 수퍼유저 URL 기동 거부 |
| ④ 통합 이미지 install-동형 호스팅 스모크 | PASS | `verify_internal_host_runtime.sh` — 단일 oort 이미지, install.sh 동형 시퀀스(기반 --wait→원샷 run→앱 --wait), Caddy 엣지, 마이그레이션 멱등 2-pass, REST→relay publish, **@멘션→mock hermes SSE 실왕복** |
| ⑤ 백업/복원 리허설 | PASS | `verify_backup_restore_rehearsal.sh` — pg dump→복원→검증 쿼리 |

## 리허설이 잡아낸 결함 4건 (전부 당일 수정·main 랜딩)

1. compose `up --wait`가 exit-0 원샷(web-init 등)을 실패로 판정하는 quirk → 부팅을 **install.sh 동형 시퀀스로 교정**(98a1352 계열) — 리허설 충실도도 상승.
2. `--wait` 한도 300s가 병렬 부하에서 3초 차 초과 → 600s 파라미터화.
3. 528 fail-closed 이후 grant 미시드 스택에서 mock 툴콜이 승인 대기로 정지하는 잠복 픽스처 갭 → `MOCK_HERMES_TOOL_CALLS` 토글(기본 동작 불변).
4. 증적 블록의 565 이전 이미지 변수 잔재 → 단일 `MOMO_IMAGE` 반영.

## Not covered (Phase 2 스코프 — 공개 호스트에서)

공개 TLS/DNS(ACME), 실 레지스트리 pull(ghcr publish 후), SOPS 실시크릿 주입, pgBackRest PITR 실복원, 초대 링크 공개 왕복. **Phase 2는 내부 도커 호스트 검증+UXUI 피드백 후**(성재 2026-07-23) VPS/도메인 요청 시점에.

## 게이트 판정

공개 릴리스 게이트(§6): 554 랜딩 ✅ · **리허설 Phase 1 PASS ✅** · README/SECURITY(MOMO-564) ⏳ · 체크리스트 4조건 중 (a) LICENSE/NOTICE 이미지 동봉=565가 빌드 시 단정 ✅, (b) 공개 전 이미지 스캔·(c) semver 태그·(d) 수동 dispatch=공개 실행 시점 절차.
