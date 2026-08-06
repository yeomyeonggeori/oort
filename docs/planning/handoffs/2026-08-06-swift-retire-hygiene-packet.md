# 핸드오프 패킷 — Swift 상시 빌드 퇴역 + 레인·게이트 위생 (2워커 단발, 발사 대기: oort1·첨부 랜딩 후)

- status: **ready-after(#1110·#1111 머지 후)** — 워커 B(첨부)가 openapi 게이트·server-rust를 만지는 중이라 파일 경합 회피
- 정본: **ADR-0145 증보 2**(Swift 퇴역 3자리) · 적립 이슈 #1022·#1035·#1051·#1069·#1089·#1099·#1101·#1108 · #1058 기록(infra/rust 컴포즈·pgdata 볼륨 함정·sampled-on-rust 잠식 기제)

## 워커 A — 레인 rust 이관 (#1022 + #1035 + #1051 + #1069 + #1101)
- **핵심**: `lane:phone`의 서버 스택을 Swift e2e 컴포즈 → **infra/rust 컴포즈 부분집합**으로 교체(`lane-phone.sh` 재배선 — 픽스처 시드·mock_hermes 연동 방식은 rust 스택의 시드 모드(`MOMO_AGENT_SEED_MODE=e2e` 계열, #1058 실측) 재사용. 고유 프로젝트명·`DB_VOLUME_NAME` 덮어쓰기(#1058 함정)·down -v).
- **#1051**: 레인 스택 centrifugo `allowed_origins`에 RN 앱 origin 추가 + 레인에 **폰 실시간 단정 1개 이상**(수신 프레임 실검증 — "레인 초록이 실시간을 보증"하게).
- **#1069**: 20-stop의 목 턴 오픈 타이밍 재설계(rust 이관과 함께 — 연속 실행·콜드 조건에서 3연속 초록 증명).
- **#1035+#1101**: 부트스트랩 자가 치유 — `--no-build`를 빌드 산출물 부재 시 조기 거부(스택 기동 전) + `build-sim.sh` 워크스페이스 부재 시 자가 `pod install` + React-Core-prebuilt 경로 의존 desync 원인 규명·완화(락 변경은 규명 후 별도 판단).
- 검증: 새 워크트리에서 **레인 풀 사이클 2연속 green**(부트스트랩부터) + 기존 5 플로우 무회귀 + 실시간 단정 red proof(origin 제거 시 빨강) + Docker 잔여 0. PR "Closes #1022"(본문에 #1035/#1051/#1069/#1101 부분 해소 명시 — 완전 해소만 Closes 추가).

## 워커 B — 게이트 위생 (#1089 + #1099 + #1108 + ADR-0145 증보 2-②)
- **Swift 패스 강등**: `verify_openapi_contract.sh` 1차(Swift) 패스를 기본 off(`OPENAPI_GATE_SWIFT_PASS=1` opt-in — 취지 주석: 스펙=Rust 서술, 권위=sampled-on-rust). Rust 패스가 기본 단독 — known-unsampled 의미 불변, **매니페스트 밖 연산은 "스펙에 있으나 어느 패스도 안 봄" 상태가 되므로 그 목록을 게이트가 경고로 출력**(조용한 커버리지 소실 금지 — 잠식 완료까지의 과도기 정직성).
- **#1108**: `scripts/verify_merge_tree.sh` 신설 — 병합 트리에서 웹·폰·코어 3종 typecheck+핵심 스위트(오케스트레이터 머지 루틴의 스크립트화).
- **#1089**: gate:shell TimeoutError·gate:shell-layout·gate:my-sessions·gate:huddle 선재 FAIL 4건 규명·수리(각각 원인 분리 — 못 고치면 원인 기록+skip 마킹, 조용한 빨강 방치 금지). gate:scroll 라이브 자격증명 → 스텁 계정 or 명시 skip.
- **#1099**: capture:design 모바일 openSheet 30초 타임아웃(95/118 중단) 수리 + #1057(설정 표면 미포함) 동반.
- 검증: 게이트 전판 실행표(green/skip+사유) + red proof(Swift 패스 opt-in 복귀 동작·merge-tree 스크립트가 고의 드리프트 검출) + `cargo test --workspace` 무회귀. PR "Closes #1089"(부분 해소는 본문 명시).

## 공통
단발 Opus·스크래치 파일명 고유·전 스위트+lint 총계·이탈 절·STOP·시크릿/프로덕션 금지. Xcode Cloud 비활성·RN 재활성은 **범위 밖**(별도 실측 진행 중 — 성재 수동 필요 범위 확정 후).
