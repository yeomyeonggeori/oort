# 핸드오프 패킷 — #1332 GHCR 재배포 고지 bundle + drift/release gate

- status: ready · planning: PLN-20260815-01 · owner: Fable(momo-main) · integrator: momo-main
- 기준 커밋: `origin/track/engine` (#1330 랜딩 이후 — PR #1342 스쿼시 포함)
- 이슈: **#1332** (P0 · **AC 정본은 이슈 본문** — 이 패킷은 좌표·계약·함정만 보탠다)
- 결재: interview_20260820_074206 Q2 (GHCR 체인 착수). supersedes: 없음
- 워커: grok 4.6 단독(병렬 1) · 검수: Fable · **발행 dispatch는 이 goal 범위 밖**(랜딩 후에도 수동 법무 검토+owner 승인 전 불허 — 이슈 원장)

## 결정 요약
Rust GHCR 이미지가 실제 재배포하는 의존성(Cargo·npm·Debian OS 레이어)의 고지를 **결정적으로 생성·이미지 동봉**하고, lockfile/이미지 드리프트를 fail-closed 게이트로 고정한다. #1225는 allow/deny 정책만 닫았고 고지 **생성**은 미자동화 상태(CONTRIBUTING.md:81 자인)라는 갭을 닫는 goal.

## 파일 맵 (전부 이 세션 실측)
- `NOTICE`(루트) — 커버리지 정직성 고지 자체가 "Rust 644 crates·npm 1,258 미커버"를 자인. AC가 이 문면의 재작성 요구
- `legal/THIRD_PARTY_NOTICES.md` — 은퇴 SwiftPM **동결 스냅샷**(생성기 2026-08-10 은퇴, #1201) → 현행/역사 구분 인덱스로 개편 대상
- `deny.toml` — cargo-deny(licenses만) 2워크스페이스(server-rust·clients/desktop/src-tauri) 공용, allow 항목별 근거 주석
- `scripts/check_cargo_licenses.sh` · `scripts/check_npm_licenses.mjs` — 기존 검사 게이트(CI rust/node 레인 — 검사만 있고 생성 없음)
- `scripts/local_gate.sh` — `license` 프로파일 기존재(여기에 stale-bundle RED 편입)
- `.github/workflows/publish-images.yml` — workflow_dispatch 전용·release Environment·SLSA attestation. **#1330이 이미지 2본 체제로 확장**(app + `infra/rust/postgres-pgbackrest/Dockerfile`) — 계약 테스트 `scripts/tests/test_publish_images_contract.py`
- `server-rust/Dockerfile` — 웹 번들 `/opt/momo/web/`(:231), 프로젝트 LICENSE·NOTICE 복사 지점은 워커가 실측
- 입력 정본: `server-rust/Cargo.lock` · `clients/web/package-lock.json`(이미지가 싣는 웹은 **clients/web** — web-legacy 아님, `server-rust/Dockerfile:147-231` 실측)

## 지켜야 할 계약
- **결정성**: 동일 입력 2회 생성 byte-identical — 타임스탬프·해시맵 순서·로케일 의존 금지, 정렬 고정. 외부 도구(cargo-about 등) 채택 시 버전 pin과 재현성 근거를 택일 상신에 포함(자체 스크립트 vs 외부 도구 택일은 워커 몫)
- **fail-closed**: 누락 라이선스 파일·식별 불가·stale bundle 전부 RED. 정책(allow/deny) 확장 금지(Out of scope)
- **정직 라벨**: 법적 충분성 선언 금지(이슈 문면 그대로 — "사실·재현 가능한 산출물"만). OS 레이어 GPL/LGPL은 오분류 금지(permissive 아님 — aggregate 동봉이며 판단은 법무 검토 몫)
- 시크릿 비유입 · push/PR/머지 금지(로컬 커밋만·체크포인트 커밋 권장) · schema 비접촉

## 함정
- **AC는 #1330 랜딩 전 문면** — 지금 발행 워크플로는 이미지 2본(app+postgres-pgbackrest). postgres 이미지의 dpkg 레이어·pgBackRest·libssh2(NOTICE 항목은 #1330이 가산)까지 커버할지 **택일 상신 후 집행**(권장: 2본 모두 — 발행되는 것 전부가 재배포다). 어느 쪽이든 이탈 보고에 명시
- Debian dpkg 검증은 **이미지 안**에서(`/usr/share/doc/*/copyright`) — 빌드 필요. 로컬 빌드는 warm cache 전제(`server-rust/Dockerfile`), docker 불가 시 그 단계만 정직 라벨
- `NOTICE` 재작성 시 "Open Source Licenses 화면" 주장 제거 — 그 UI는 #35/별도 goal(Out of scope 경계 유지)
- 게이트 편입은 **검사 위치 이중화 금지** — 기존 check_* 게이트와 신설 drift 게이트의 역할 경계를 문서 1곳에 고정
- `docs/planning/ENGINE_HANDOFF.md`에 #35 소비용 ready 항목 추가(AC 마지막 항)

## 검증 (AC 외 추가 요구)
- mutation RED 증명은 각 1회 실행 로그를 최종 보고에 표로(의존 버전 변화·license 삭제·Docker copy 제거·GPL 오분류)
- byte-identical 2회 생성 diff 출력 첨부
- `local_gate --profile license`·`--profile docs` 그린 + 신설 테스트 전부

## 착수
`scripts/goal_claim.sh --base track/engine 1332` → 이 패킷+이슈만으로 착수. 완료 시 최종 출력: ## 요약 / ## 택일과 논거(생성기·이미지 2본 범위) / ## 변경 파일 / ## 재검증 표(mutation 포함) / ## 계획 이탈 / ## 티켓 후보
