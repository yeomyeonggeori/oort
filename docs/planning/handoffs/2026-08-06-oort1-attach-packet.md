# 핸드오프 패킷 — oort 1단계(#1110) + 첨부 서버 이식(#1111) (2워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신 · 새 워크트리 · 단발 Opus(완주 후 최종 보고 1회) · 워커별 스크래치 파일명 고유(공용 pr-body.md 금지)

## 워커 A — oort 1단계 (#1110)
- 정본: **ADR-0152 Accepted**(D1 동결층·D2 1단계) · `research/2026-08-05-oort-naming-inventory.md` 축1(12곳 목록·file:line).
- 과업: 사용자 노출 momo→oort 전환 — tauri.conf.json productName/타이틀 · `PushDispatch.swift:104` 푸시 제목 · iOS/macOS/desktop Info.plist usage 문구(문장 자연스럽게 — "oort 메시지에…") · web-legacy/index.html 타이틀 · release-macos.yml DMG 볼륨·파일명 · macOS CFBundleName 경로(타깃명 개명 없이 표시명만 — PRODUCT_NAME 간접이면 INFOPLIST 키로 분리). 인벤토리가 12곳이라 했지만 **네가 재전수**해서 축1 기준 누락 없이(단, 동결층·축2 식별자·주석·테스트 픽스처는 제외 — 화면·OS·산출물에 보이는 문자열만).
- **동결층 접촉 금지(하드)**: `app.momo.*` 번들ID·APNs·App Group·keychain·`com.dawnkim.momo`·플러그인ID·`MOMO-NNN`·DB role·`MOMO_*` env·schema id·`X-Momo-*` 헤더.
- 검증: 각 클라 빌드 가능성(웹 build·mobile typecheck·tauri conf 유효성·plist plutil lint) + 전 스위트 무회귀 + grep 증명(축1 잔여 0 — 제외 규칙 명시) · red proof 1(전환 지점 하나 되돌리면 grep 게이트 빨강). PR "Closes #1110"·이탈 절·STOP.

## 워커 B — 첨부 v0 서버 (#1111)
- 정본: **ADR-0151 Accepted** D1/D3 · 이식 원본 `server/Sources/MomoServer/Routes/AttachmentRoutes.swift`(바이트 우회·mime 검증·pending·불일치 거절) + `MessageRoutes.swift:173-183,205,251`(attachmentIds 링크·동봉) · 스펙 `docs/api/openapi.yaml:2991,3041,3080` · Drive 연동 선례: server-rust 내 기존 Drive 클라이언트/설정(실측해 재사용 — 없으면 Swift CloudProviderKit 대응 이식 범위 포함, 이탈 절 보고).
- 과업: 3경로+메시지 바인딩을 server-rust로 — 와이어 무변경(camelCase 규율·스펙 대조), RLS·단일 쓰기경로·provider 자격증명 비유입(ADR-0004) 불변식 준수. 스키마 변경 금지(`schema_v0.sql` 불변 — attachment 테이블이 이미 있는지 실측, 없으면 마이그레이션 파일로).
- 검증: `cargo test --workspace` 무회귀 + 신규 실DB 스위트(3경로 왕복 — Drive는 목/스텁 계층으로, 실 Drive 접촉 금지) + red proof ≥2(업로더 불일치 링크 거절·mime 불일치 complete 거절) · openapi 게이트 정합(가능하면 sampled-on-rust 매니페스트 등재 — 부분집합 스택으로 왕복 성립 시. 불성립이면 사유 기록) · **병합 트리 3종 typecheck**(#1108 규율 — 클라 접촉 없어도 확인). PR "Closes #1111"·이탈 절·STOP.
- 함정: infra/rust pgdata 고정이름 볼륨(#1058 기록 — DB_VOLUME_NAME 덮어쓰기) · Docker 자원 down -v 회수.

## 공통
시크릿·프로덕션 접촉 금지 · lint 총계 줄 · 두 워커 파일 전면 무교차(A=클라 표시 문자열·relay·CI, B=server-rust·migrations·openapi 게이트) — 교차 발견 시 즉시 멈추고 이탈 보고.
