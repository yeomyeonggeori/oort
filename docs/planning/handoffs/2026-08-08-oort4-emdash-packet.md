# 핸드오프 패킷 — oort 배치 4(#1118 잔여) + 웹 emdash AST 이관(#1141 완결) (2워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신(#1172 머지 후) · 워커=단발 Opus 무명 · 발주 전 랜딩분 대조 완료(#1118 잔여=#1159 워커 실측 목록·웹 emdash=#1171이 남긴 것 — 둘 다 미착수) · 중간 보고 없음
- 경합 지도: W-I=Swift server/·openapi·docs·픽스처(클라 소스 무접촉) / W-J=scripts/design_preflight_web.sh·clients/web 문자열·local_gate — **무교차**.

## 워커 I — #1118 잔여 일소 (oort 배치 4)
- 목록(#1118 이슈 코멘트 2026-08-07 실측): ①**Swift `server/` 사용자 노출 카피 ~50곳** — 주의: prod 이미지가 아직 이쪽을 빌드(`infra/prod/docker/momo.Dockerfile:25`)하므로 **문자열만, 코드 구조 무접촉**. Inbound MCP 도구 제목(`Search Momo Messages` 등)은 T3-off로도 도달 가능한 표면 — 포함. Swift 빌드는 돌리지 않는다(ADR-0145 퇴역 — 단 문자열 치환이 컴파일을 깰 수 없는 형태인지 diff 자기검토로 보증: 리터럴 내부만) ②`docs/api/openapi.yaml`+생성 타입의 카피(계약 키·경로는 동결 — description/제목류만) ③ROADMAP.md 13건(main 정본 기준 — **main에서 수행**이 아니라 track/engine의 ROADMAP이 main과 skew면 건너뛰고 기록) ④`.claude/skills` 산문 ⑤하이픈 합성어 109(#1150 분류 규칙 그대로 — 동결층 제외) ⑥mobile 픽스처 5.
- 동결층 절대 불변: `app.momo.*`·`com.dawnkim.momo`·`MOMO_*` env·`momo_app` 등 role·`X-Momo-*`·`MOMO-NNN`·번들/타깃/크레이트 이름·URL/경로. 게이트(`gate_oort_user_facing.sh`) PASS+동결 토큰 수 before/after diff 0 기계 증명(#1150·#1159 전례).
- 검증: oort 게이트 PASS·docs 게이트·동결 diff 0·openapi 드리프트 게이트(생성 타입 재생성 왕복)·병합 트리 3종. PR "#1118 배치 4 — 잔여 표에서 macOS 'm' 배지·골든 문구(이슈 명시 유지분)만 남김" 명시(Closes 판단은 잔여 0이면 Closes, 아니면 코멘트)·이탈 절·STOP.

## 워커 J — 웹 emdash AST 이관 + 부채 12 일소 (#1141 완결)
- #1171이 만든 도구(`scripts/design_preflight_core.mjs`의 AST 분리 — TS 문자열 리터럴 노드만)를 웹 emdash 분류에 이관: `design_preflight_web.sh`의 emdash 검사를 줄 기반→AST로. 그 판정으로 기존 12건(U4-4R 레인 파일 — 코어에서 오탐 판정한 것과 같은 부류=테스트 이름·주석 산문일 것)을 재분류 — **오탐이면 규칙이 자동 해소**, 진짜 렌더 문자열이면 수리(일괄 치환 아님 — 건별 판단). 목표: 웹도 하드 제로 → `local_gate.sh --profile web` 편입(#1171이 남긴 조건).
- 검증: preflight selftest(웹 11+코어 17 무회귀+웹 AST 케이스 추가)·red proof 2(웹 렌더 문자열 주입→빨강·주석 동일 문자→통과)·웹 스위트+lint 총계·병합 트리 3종(7레인). PR "Closes #1141"(코어 축은 #1171 기완 명시)·이탈 절·STOP.

## 공통
무명 단발 Opus·`origin/track/engine` 새 워크트리·시크릿/프로덕션 금지·Docker 불요(스위트만)·워크트리 보고 후 대기. 스크래치 접두 `oort4-*`/`emdash-*`. 랜딩 후 배포 묶음(#1171·#1172 포함)은 오케스트레이터가 수행.
