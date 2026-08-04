# 핸드오프 패킷 U3 — AI 연결: OAuth 등록 폼 + 연결 상태 표면 (웹)

- status: **ready** · worker: Opus 5 (웹 설정 전속) · 기준: `origin/track/engine` 최신 · 새 워크트리 · PR base `track/engine`
- 발단(실사용 증거): ADR-0147(OAuth 봉투)이 서버만 랜딩 — 2026-08-04 실등록을 **브라우저 콘솔 스니펫으로 우회**해야 했다. 만료/실패 시 사용자가 볼 화면이 없어 "실패 카드가 첫 신호"인 상태. UXUI 고도화 U3 축(`docs/planning/2026-08-05-uxui-elevation-points.md` §3).
- **병렬 경계(하드)**: B3W(대화 표면+core)·B3M(모바일)이 동시에 돈다. **네 전속 = `clients/web/src/features/settings/**`** (+ 스펙 재생성 산출물). 대화 표면(chat/timeline/composer/realtime)·`packages/momo-core`·모바일·서버 소스 금지. 부족하면 이탈 보고.

## Goal 1 — OAuth 등록 폼

- 현재: `AiLinkSection.tsx`(388줄)는 baseUrl+bearer+mode 폼뿐. `ProviderLinkInput`(`features/settings/api.ts:126-130`)은 closed-world 주석이 달린 3필드 — **서버는 이미 `oauth` 객체를 받는다**(ADR-0147, 라이브 검증됨). 주석이 스펙보다 낡았다.
- 작업: 「ChatGPT 계정 연결(OAuth)」 등록 방식 추가 — `auth.json` 붙여넣기(텍스트영역) → 클라 파싱(refresh/access token·account id·client id) → `PUT /v1/provider/link`에 `oauth` 객체로 전송. 기존 bearer 방식과 방식 선택 UI로 공존.
- **와이어 필드명 정본 = `docs/api/openapi.yaml`(#1040 정정본 — camelCase)**. 이 패킷의 필드 나열을 믿지 말고 스펙 실측 후 배선. 스펙에 oauth 스키마가 없으면 서버 dto 실측(`server-rust` provider_link 계열) + 이탈 보고(스펙 갭).
- 규율: 비밀값 화면 재노출 금지(기존 write-only 규율 — `AiLinkSection.tsx:39,143` 계열 유지). 파싱 실패는 필드 단위 한국어 오류. 붙여넣은 원문은 저장/로그 금지.

## Goal 2 — 연결 상태 표면

- GET `/v1/provider/link`가 실제 주는 것(bearerLast4·모드·마지막 저장 등)을 실측하고, `POST /v1/provider/link/test`(기존 `testProviderLink`) 결과를 상태 카드로: 등록 방식(키/OAuth)·마지막 test 시각·성공/실패 사유(사람 어휘 — `model.ts:276` 라벨 변환 재사용).
- GET에 OAuth 상태(계정 라벨·만료)가 없으면 **클라에서 지어내지 말고** 이탈 보고(서버 소보강 후속 티켓감). 서버 수정은 이 배치 범위 밖.

## 검증 (각 goal)

전체 웹 스위트+typecheck + red proof ≥2(①`oauth` 키 포함 PUT 페이로드 형상 단정 — 미지 키 400 규율과의 공존 실측 ②비밀 재노출 금지 단정) · 기존 settings 게이트 확장 또는 `gate:ailink` 신설 · **라이브 서버 접촉 금지**(로컬 스택만). PR "Closes #1047" · `## 계획 이탈` 절 · STOP(머지 금지). 턴 규율: 턴 ≤20분 · 마일스톤마다 SendMessage 보고 · 첫 보고 ≤30분.
