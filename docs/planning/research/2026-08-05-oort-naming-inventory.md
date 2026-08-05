# oort 네이밍 인벤토리 (momo 레포 전수) — 2026-08-05

> 스캔 기준: origin/track/engine. 1,763 파일 / 27,917줄에 momo 출현. 조사: Explore 에이전트(전수 grep 분류).
> 선행 사실: 리브랜딩은 이미 시작됨(goal B13/B4.4) — web index/manifest·mobile displayName·macOS deeplink(oort:// 발급, momo:// 수용)·OortMark.tsx. 아래는 잔여분.

## 축 1 — 사용자 노출 문자열 (잔여 ~12곳) · 전환 1순위 · 위험 거의 없음
- 데스크톱 앱 이름·타이틀: clients/desktop/src-tauri/tauri.conf.json:3,16 ("momo")
- **모든 푸시 알림 제목**: relay/PushRelay/Sources/PushRelay/PushDispatch.swift:104 (title="momo") — 릴레이 재배포 필요
- OS 권한 프롬프트: clients/iOS/XcodeHost/Info.plist:45,47,49 · macOS/desktop Info.plist — 앱 재제출 필요
- 알파 웹 타이틀: clients/web-legacy/index.html:9 · DMG 볼륨명: .github/workflows/release-macos.yml:64,68 · macOS CFBundleName(타깃명 결합)

## 축 2 — 레포/패키지 식별자 (~273 파일) · 대규모지만 기계적
- npm 9종(@momo/core·momo-web·momo-mobile 등) · Rust crate/bin 18종(momo-*) · Swift/SPM 8종(Momo*) · Xcode 프로젝트 3세트 · repo명 · scripts/momo 등 4종
- 함정: crate rename은 workspace·Cargo.lock·Dockerfile bin 경로·compose command 동시. Xcode 타깃명은 pbxproj·scheme·entitlements·CI가 한 몸(서명 파손 위험).

## 축 3 — 번들/서명 (~82) · **동결층(전환 금지)**
- app.momo.ios(+tests·NSE) · APNs topic · group.app.momo.ios · keychain app.momo.ios.shared · com.dawnkim.momo · app.momo.desktop · com.momo.plugins.*
- 변경 시: App Store 신규 레코드·기존 기기 푸시 전량 무효·저장 세션 접근 불가. **명시 동결.**

## 축 4 — 인프라/운영 (236 파일) · 조용히 큼
- MOMO_* env 342종/342파일 · compose 프로젝트 7종(momo·momo-prod·momo-rust·momo240_$$…) · janitor가 momo_*/momo240_* 접두사 하드매칭(scripts/compose_janitor.sh:203-231) · ghcr 이미지 7종 · /opt/momo-web·/srv/momo-web·/var/lib/momo · _momo._tcp Bonjour · POSTGRES_DB/USER 기본 momo · 도메인 잔재(momo.local 278 등)
- 함정: 프로젝트명 변경→볼륨 고아화+janitor 무력화 동시(발열 전례). env 접두사→배포 env 전량+코드 258파일 한 커밋. _momo._tcp→구클라 발견 단절.

## 축 5 — 와이어/DB 계약 · **위험 최고**
- 깨끗한 것: 테이블·컬럼·RLS GUC(app.workspace_id) — CREATE TABLE에 momo 0건, schema_v0.sql은 주석 2줄뿐.
- 계약: X-Momo-* 서명 헤더(~30 — HMAC base 포함, ADR-0115) · wire schema id momo.*.vN **343건**(정확 일치 검증 — 불일치 시 푸시 드롭) · APNs payload 키 momo · DB role 5종 ~900건(momo_app 449 등) · SQL 함수 14종(momo_password_hash 등) · 클라 저장 키 momo.web.session.v1 등(~20 — 변경=전 사용자 로그아웃) · S3 momo-attachments · __momo_stub
- 함정: 헤더는 동시 배포 아니면 401 fail-closed. role은 부트스트랩 SQL·DSN·verifier 13종 동시+기존 DB GRANT 이관.

## 축 6 — 문서/브랜드 · 낮음, 함정 1
- .md 358파일/7,544줄 · docs 266 · research 98 · **MOMO-NNN 티켓 참조 5,885건 — 번역 금지 동결**(치환 시 이력·이슈 상호참조 전파괴) · 스킬명(momo-design-taste 등)·CLAUDE.md/AGENTS.md

## 전환 단계 제안 (인벤토리 결론)
0. **동결 선언(ADR)**: MOMO-NNN·축3 전체·DB role — "안 바꾼다" 명시(워커 선의 방지)
1. **사용자 노출(축1 잔여 12곳)**: 위험 0·체감 100% — 즉시 가능
2. **문서 산문(축6)**: 티켓·경로·식별자 인용 제외 정규식
3. **신규 표면만 oort(축5 우회)**: 새 schema=oort.*.v1·새 헤더=X-Oort-* — deeplink 검증 패턴(발급 신, 수용 구+신)
4. **인프라(축4)**: janitor 양쪽 매칭 선행 → env 2단 읽기(OORT_* 우선·MOMO_* 폴백) → compose는 신규 스택부터+볼륨 재바인딩 계획. repo명·ghcr도 이 묶음
5. **패키지 식별자(축2)**: @oort/core·oort-* crate — 트랙 단위, Xcode 타깃명 맨 뒤
6. **장기 별도 ADR(축5 잔여)**: 헤더 v2 신설·저장 키 read-old/write-new·role 무중단 GRANT 이관

**요약**: 사용자 층은 절반 전환됨+잔여 12곳 즉시 가능. 진짜 비용은 축4(env 342·janitor 연쇄)·축5(헤더·schema id 343). 축3은 전환이 아니라 동결이 옳다.
