# 워커 브리프 — v0.1.3 발행 문면 현행화 + SELF_HOST §6 읽기 개방 정정

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/main(v0.1.3 빌드 커밋)
> 게이트: **v0.1.3 발행 완료 후 착수**(digest 확정 전 착수 금지 — 종합 테스트 패킷 ①).
> 트랙: docs-only. 코드 무접촉. 라이브 리그 DB 비접촉(상설 정지 조건 — 이 티켓은 DB 자체가 불필요).

## 목적
종합 실테스트(패킷 `2026-08-28-comprehensive-test-packet.md`) 준비 체인 ②.
v0.1.3 발행으로 확정된 digest를 셀프호스트 문면에 pin하고, #1820(ADR-0173) 랜딩으로
거짓이 된 §6 읽기 서술을 정정한다.

## 작업 (전부 docs/)

### 1. `docs/SELF_HOST.md` §2-B digest pin 현행화
- v0.1.3 Release의 **manifest list digest**(앱 + postgres)로 교체. Releases가 digest 정본 — 문서는 예시 인용.
- **선재 정합 결함 동반 수리**: 현행 문면은 "v0.1.1 공개 발행의 앱 list digest(빌드 커밋 main=1b79bc65)"라 쓰고 digest는 v0.1.2 값(`43babdbc…de6d`)을 싣고 있다. 버전 라벨·빌드 커밋·digest 3자를 v0.1.3으로 일치시킬 것.

### 2. `docs/SELF_HOST.md` §6 "오늘 안 되는 것" 정정 (#1820 반영)
현행: "이 자격으로 채널 히스토리를 GET 할 수는 없다. 읽기 스코프를 넣어도 REST는 403" — **#1820 랜딩으로 거짓**.
정정 내용(ADR-0173 정본 준수):
- `messages:read` 스코프로 **채널 히스토리 GET·스레드 replies GET 200** — 스코프는 비-default라 발급 시 명시해야 함(`"scopes":["messages:write","messages:read"]` 예시 갱신).
- 계속 닫힌 것 명기: 단일 메시지 GET·replies POST·검색. hosted 자격은 여전히 REST 전체 403(MCP 격리 유지 — ADR-0162).
- `409 hosted_connection_managed` 문단·회수 절차는 불변 유지.
- 근거 링크에 ADR-0173 추가(기존 #1797 research 링크 유지).

### 3. `docs/llms.txt` 정합 확인
- digest·버전 언급이 있으면 v0.1.3으로 갱신, 없으면 무변경 보고.

## 금지
- SELF_HOST §6 예시의 셸 구조(변수·HUMAN 폐기 흐름) 재설계 금지 — 스코프 배열·서술만 정정.
- ADR 문서 수정 금지(정본은 이미 Accepted). schema/코드 접촉 금지.

## 완료 기준 (red proof는 docs-only라 대체)
- grep 증명 3종을 PR 본문에 첨부:
  1. `grep -n "v0.1.1\|1b79bc65" docs/SELF_HOST.md` → §2-B에서 0건(또는 역사 서술로만 잔존, 사유 명기)
  2. `grep -n "읽기 스코프를 넣어도" docs/SELF_HOST.md` → 0건
  3. `grep -n "messages:read" docs/SELF_HOST.md` → 발급 예시+개방 서술에 실림
- PR → main 직행(docs-only, 트랙 비경유 — 발행 문면은 main 정본). 머지=오케스트레이터.
