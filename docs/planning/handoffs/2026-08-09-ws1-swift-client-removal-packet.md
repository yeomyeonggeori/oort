# 핸드오프 패킷 — W-S1: Swift 클라이언트 3트리 삭제 (감사 1+2단계)

> 준비: 2026-08-09 심야 Fable. **발사는 성재 명시 신호 대기.**
> 판정 선행조건 종결됨(판정표 §3 — 2026-08-09 성재 4결정). 정본: `docs/planning/research/2026-08-09-swift-removal-audit.md`(§6 순서·§11 재기준화 정정) · `2026-08-09-swift-family-disposition-table.md`.

## 0. 범위 — 이번 배치는 1+2단계만

| 단계 | 내용 | 이 패킷 |
|---|---|---|
| 1단계 | 메타데이터 정리(트리 무접촉) | **포함** |
| 2단계 | 클라 3트리 삭제(`clients/macOS` 327 · `clients/iOS` 50 · `clients/Core` 30 ≈ 407파일) + 동반 정리 + **#1201 게이트 은퇴** | **포함** |
| 3단계 | web-legacy 승계 | **제외 — 성재 A/B/C 결정(S6) 대기** |
| 4단계 | 셀프호스트 배포 Rust 전환 | 제외 — 별도 티켓·별도 워커(감사 권고) |
| 5단계 | 서버/워커/릴레이 Swift | 제외 — `relay/OutboxRelay`는 **#1222 완료 전 삭제 금지**(판정표 §3) |

## 1. 하드 금지 (건드리면 사고)

- **`clients/mobile/**` 절대 무접촉** — RN 제품 트리. ⚠ 감사 §9의 옛 좌표(`gate_oort_user_facing.sh:44-49`)를 문자 그대로 쓰면 engine에선 `:48-50`이 mobile/ios라 **오폭한다**(#1216 §11 적발). 게이트 정리는 **줄 번호가 아니라 경로 문자열로**: 스캔 루트에서 `clients/macOS/…`·`clients/iOS/…` 항목만, 허용 예외에서 그 두 트리의 파일만 제거.
- 존치(살아있는 제품): `relay/PushRelay`(유일 APNs) · `relay/OutboxRelay`(#1222 전) · `workers/WorkHostDaemon`(T3 종착 바이너리) · `workers/{AgentWorker,NotifierWorker}`(5단계) · `server/**`(Migrations=라이브 SoT) · `services/MomoMetrics`.
- Xcode Cloud는 오늘 `MomoMobile.xcworkspace`/scheme `MomoMobile`로 재조준·그린 확인됨 — `clients/iOS` 삭제가 CI를 깨지 않는다(빌드 2039+ 실측). ASC 콘솔 재작업 불요.

## 2. 작업 순서 (커밋 분리 — 참조 제거와 트리 삭제를 같은 커밋에 넣지 않는다)

1. **[커밋 1] 메타데이터**: `.github/ISSUE_TEMPLATE/*`·`pull_request_template.md`의 `[swift]` 등급 · `.github/labels.json`의 `area:macos`/`area:ios` · `docs/api/openapi.yaml` 머리말 정정. 게이트: docs 프로파일.
2. **[커밋 2] 참조 0 만들기**: `.github/workflows/{ci-build,release-ios,release-macos}.yml` 삭제 · `fastlane/**`+`Gemfile` 삭제 · `scripts/{macos_dev_run,verify_macos_real_backend_ui*,verify_ios_*,publish_alpha_build,generate_ios_app_icon}.sh` 삭제 · `verify_design_preflight.sh` SRC_DIRS 정리(웹 preflight 승계 확인 후 폐기 가능) · `local_gate.sh`의 `macos-ui`/`ios` 프로파일 제거 · `Makefile` SWIFT_PKGS 축소 · `gate_oort_user_facing.sh` 정리(§1 방식) · **`check_spm_licenses` 은퇴**(#1201 — 성재 기결정: 삭제와 함께. base부터 red였던 게이트).
3. **[커밋 3] 트리 삭제**: `clients/macOS` + `clients/iOS` + `clients/Core` 동시.
4. 각 커밋마다 게이트 그린 확인 후 다음으로.

## 3. 검증 (전부 통과해야 PR)

- 병합 트리 **8레인**(`scripts/verify_merge_tree.sh` — web lint 포함) 전부 green.
- `gate_oort_user_facing.sh` green(정리 후 빈 스캔 루트/존재하지 않는 예외 경로 0 — 감사 §2-5의 "지우면 그 자리에서 깨진다" 방지).
- `local_gate.sh --profile docs` green · Rust 이미지 빌드 무영향 확인(`server-rust/Dockerfile`은 클라 트리를 COPY하지 않음 — 확인만).
- red proof: 삭제 후 레포 전수에서 `clients/macOS|clients/iOS|clients/Core` 참조 grep 0(문서 이력·research 제외 규칙 명시).

## 4. 규율

- 무명 단발 Opus 워커 1기. 워크트리 신설(base=origin/track/engine). PR(base=track/engine) 만들고 STOP — 머지는 오케스트레이터.
- 이탈은 숨기지 말고 PR 본문에 근거와 함께.
- 예상 밖 참조 발견 시(감사에 없는 소비자): 지우지 말고 보고에 적립.

## 5. 보고 규약

최종 보고 = PR 번호 + 삭제 파일 수(트리별) + 게이트 결과표 + 적립 발견 목록. 중간 보고 없음.
