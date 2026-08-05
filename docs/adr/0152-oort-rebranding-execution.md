# ADR-0152 — oort 리브랜딩 실행: 동결층·6단계·게이트

- Status: **Proposed** (성재 발제 2026-08-05 — "레포 이름부터 momo 대신 oort로. Apple developer 같은 건 momo 당분간 유지, 앱 출시는 oort")
- Date: 2026-08-05
- 근거 실측: `docs/planning/research/2026-08-05-oort-naming-inventory.md` (전수 — 1,763파일/27,917줄, 6축 분류)

## Context

- 리브랜딩은 이미 절반 진행됨(웹 타이틀·manifest·모바일 displayName·`oort://` deeplink·OortMark) — 문제는 **잔여의 비대칭**: 사용자 노출 잔여는 12곳뿐인데, 인프라(env 342종·compose·janitor 연쇄)와 와이어 계약(서명 헤더·schema id 343건·저장 키·DB role)은 잘못 건드리면 푸시 드롭·401 fail-closed·전 사용자 로그아웃·볼륨 고아화를 만든다.
- 성재 방침: 내부 구어 "모모" 허용, Apple Developer 자산 당분간 momo 유지, 출시명은 oort.

## Decision

**D1 · 동결층 선언 (변경 금지 — 워커의 선의 방지)**
① Apple 서명 계열 전부: `app.momo.ios`(+NSE·tests)·APNs topic·`group.app.momo.ios`·keychain `app.momo.ios.shared`·`com.dawnkim.momo`·`app.momo.desktop` ② `MOMO-NNN` 티켓 접두사(5,885 참조 — 이력 링크 보존) ③ DB role 5종(`momo_app` 등)·SQL 함수명 ④ 플러그인 ID `com.momo.plugins.*`. 해제는 각각 별도 ADR로만.

**D2 · 6단계 실행 순서** (각 단계 = 배치 1개, 게이트 그린 단위)
1. **사용자 노출 잔여 12곳**(tauri productName·푸시 title·Info.plist usage 문구·web-legacy 타이틀·DMG명) — 위험 0, 즉시. 푸시 title은 릴레이 재배포 동반.
2. **문서 산문**(358파일) — `MOMO-NNN`·경로·식별자 인용 제외 규칙 명시한 치환.
3. **신규 표면 oort 원칙**: 이제부터 새 wire schema id는 `oort.*.v1`, 새 헤더는 `X-Oort-*`(기존 불변) — deeplink가 검증한 발급-신/수용-구신 패턴.
4. **인프라**: (a) janitor를 `momo_|oort_` 양매칭으로 **선행** 확장 → (b) env `OORT_*` 우선·`MOMO_*` 폴백 2단 읽기 → (c) compose 프로젝트명은 신규 스택부터(기존은 볼륨 재바인딩 계획 동반) → (d) **repo명 momo→oort**·ghcr 이미지 경로(redirect 확인 후). 순서 위반 시 볼륨 고아화+청소 불가 동시 발생(발열 전례).
5. **패키지 식별자**: `@momo/core`→`@oort/core`·crate `momo-*`→`oort-*`(workspace·lock·Dockerfile·compose command 동시)·Xcode 타깃명은 이 단계 **맨 뒤**(서명·CI 결합).
6. **와이어 잔여(별도 ADR 필수)**: 서명 헤더는 `X-Oort-*` v2 버전 신설로만, 클라 저장 키는 read-old/write-new, role 이관은 무중단 GRANT 설계.

**D3 · 시점 게이트**: 각 단계 착수는 성재 신호. 1·2단계는 신호 즉시 가능(선행 조건 없음). repo명 변경(4d)은 org 이동 리다이렉트(yeomyeonggeori) 위에 한 번 더 쌓이므로 로컬 remote·CI·문서 URL 일괄 갱신 티켓 동반.

## Slack·업계 비교

브랜드 개명에서 표시명과 계약 식별자를 분리하는 것은 표준 관행이다 — Slack의 내부 식별자에는 전신 `tiny_speck` 계열이, Discord API에는 여전히 구명 흔적이 남아 있고, Twitter→X는 도메인·번들을 수년째 병존시킨다. 식별자까지 개명한 사례는 대부분 major version 경계에서만 수행됐다. momo도 계약층(축5)은 v2 경계로 미룬다.

## Consequences

- 사용자·문서 층 완료 후에도 코드 내부에 momo가 남는 이중 명명이 장기 지속 — CONTRIBUTING/AGENTS에 "내부 식별자 momo는 의도적 잔존(ADR-0152 D1)" 명시 필요.
- Apple Developer의 momo 유지로 App Store 표시명(oort)과 번들 id(app.momo.ios)가 불일치 — 심사상 문제 없음(표시명 자유), 팀 내 혼동만 문서로 방어.
- 도메인 정본은 oor7.com(기확정) — momo.local 등 dev 도메인 잔재는 4단계에서.
