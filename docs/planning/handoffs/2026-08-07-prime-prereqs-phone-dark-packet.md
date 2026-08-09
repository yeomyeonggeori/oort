# 핸드오프 패킷 — prime 전제 잔여(#1130 ②③) + 폰 다크 여명화·소형 문서(#1155·#1157) (2워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1158·#1159 머지 후) · 워커=단발 Opus · 스크래치 파일명 고유 · 중간 보고 없음(완주 후 최종 보고 1회)
- 정본: #1130(스파이크 판정·전제 3건 — ①edit 계약은 #1152로 완료) · `docs/planning/research/2026-08-06-prime-agent-spike.md` · #1155(#1153 리뷰 M-3 파리티) · #1157(#1156 관찰 3) · ADR-0152(oort 카피 규율)

## 워커 A — #1130 잔여: ②refine 감사 + ③HOME 격리 (스파이크 한정)
- **범위 계약**: 정식 provider 통합 구현은 **범위 밖**(#1130 Out of scope 그대로). 접촉 면=`scripts/spikes/prime-agent/**`+research 문서+이슈 초안 파일. server-rust/코어/클라 0줄.
- **② 자기수정(refine) 감사**: 스파이크 실측대로 RPC 45 커맨드 중 유일 미문서·파일 감시로만 관측 가능. 산출 둘: (a) **업스트림 이슈 초안**을 `docs/planning/research/2026-08-07-prime-refine-upstream-draft.md`로 — 재현 절차·기대 계약·우리 사용례. **업스트림에 실제 제출은 하지 않는다**(외부 발신=성재 승인 사안). (b) **우리 쪽 채널 이벤트 설계 스케치**(같은 문서 별절) — refine이 일어났을 때 채널에 어떤 이벤트/메시지로 노출할지, #1152 edit 계약(stream rev)과의 관계 포함. 설계는 제안 수준(ADR 승격 여부 판단 재료) — 구현 금지.
- **③ HOME 격리**: `~/.prime/agent/harness` 전역 상태=테넌시 누수. 스파이크 컨테이너(`scripts/spikes/prime-agent/Dockerfile`·`container_entry.sh`)에서 **워크스페이스별 HOME 분리**를 실증(env HOME 오버라이드 or 볼륨 분리 — 실측으로 고르고 근거 기록). 두 워크스페이스 시뮬레이션으로 상태 비공유 red proof 1개(격리 제거 시 누수 재현).
- 검증: 스파이크 컨테이너 빌드+실행 실측(v0.7.0 핀 유지)·red proof·Docker 자원 down -v·잔여 0. PR 본문에 "#1130 부분 해소(②③) — ①완료·정식 통합 잔여" 명시(Closes 금지 — 이슈는 통합 완료까지 열어둠). `## 계획 이탈` 절·STOP(머지 금지).

## 워커 B — #1155 폰 다크 accent 여명화 + #1157 INDEX + 깨진 링크
- **#1155 핵심**: 폰 다크 `accent: '#3b6fd4'`(파랑 — `clients/mobile/src/design/tokens.ts:207`) vs 웹 다크 `#f0a850`(호박 — `clients/web/src/design/tokens.css:42` `light-dark(#a54c08, #f0a850)`). U2가 라이트를 웹과 16역할 바이트 일치로 정렬한 전례(#1153) 그대로 **다크 accent 가족을 웹 다크에 값 단위 정렬**. 결정 근거는 발명이 아니라 파리티: 웹 다크가 이미 호박이고 라이트 정렬이 기승인 패턴이다.
- **주의 — accent 의미 재배선**: accent='내 것' 가족(내 반응·보내기 등). `#f0a850`은 밝은 값이라 `onAccent`가 어두운 쪽으로 뒤집힐 수 있음 — 웹의 다크 `--on-accent` 실측 후 동일 규칙 적용, AA 대비 산술을 코드 주석이 아니라 테스트로. 기존 단정 2곳이 파랑을 값/서술로 참조: `clients/mobile/__tests__/conversationVisual.test.tsx:1115`·`paletteContrast.test.ts:183` — 단정을 낡은 값에 맞추지 말고 새 팔레트의 참인 문장으로 재서술.
- **로그아웃 버튼 테두리(조건부 소항목)**: 큐 적립 항목이나 원 소견 문서 미발견(정직 고지). `SidebarScreen.tsx` footerButton(:438 부근)이 **새 다크 팔레트에서** 면과 묻히는지 실측 — 묻히면 테두리 한 줄(기존 border 토큰), 아니면 손대지 않고 판정만 PR 본문에 기록.
- **#1157**: `docs/INDEX.md` §2.1이 cicd 09까지만 등재 — 10·11·12(존재 시)·13 일괄 등재(내용 변경 금지). **+깨진 링크 3곳**: `docs/cicd/20-ios-push-device-check.md`를 가리키나 실파일은 `11-...`(#1159 워커 실측) — `grep -rn "cicd/20" docs/`로 전수 찾아 수리.
- 검증: 폰 jest 전판+tsc+lint 총계 줄·다크/라이트 캡처(축척 pt=px/3)·red proof 1(accent 정렬 단정이 파랑 복귀 시 빨강). PR "Closes #1155, Closes #1157"·이탈 절·STOP. **UI 변경이므로 머지 전 design-review 필수(오케스트레이터가 발주)** — PR 본문에 캡처 경로 명기.

## 공통
단발 Opus·`origin/track/engine` 기준 새 워크트리(`~/projects/momo-tracks/momo-worktrees/` 아래 고유 이름)·시크릿/프로덕션 접촉 금지·동결층(`MOMO_*` env·`momo_app` 등 role·번들ID·`X-Momo-*`) 불변·병합 트리 3종(`scripts/verify_merge_tree.sh`)·워크트리/Docker 자원 정리 후 보고.
