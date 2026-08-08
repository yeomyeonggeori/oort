# ADR-0135: 프로바이더 캐스캐이드 체인 + 잔여량 프로브 경계

- Status: **Accepted** (2026-07-26, 성재 — "둘다 승인할게". 초안 Fable 2026-07-26)
- 관련: ADR-0004(provider 자격증명 비유입 — **본 ADR은 이 경계를 유지한다**), ADR-0130, MOMO-615/616(사용량 1층), 프로그램 AX-4, 레퍼런스 §5

## Context

1. `provider_link`는 싱글톤 스키마(`id boolean PRIMARY KEY CHECK (id = true)`) — 두 번째 프로바이더를 담을 행 자체가 없다. hermes adapter도 단일 런타임 호출로 다형성 없음.
2. 성재 지시: "헤르메스도 여러 프로바이더를 폴백처럼 캐스캐이딩" + "oauth는 잔여 사용량 같은 걸 대시보드로".
3. OAuth 잔여량은 ADR-0004와 정면 충돌해 보이지만, **조회 주체를 옮기면 충돌하지 않는다**: 자격증명이 이미 있는 곳(hermes adapter/호스트)이 프로브하고 oort에는 숫자만 들어온다.
4. 레퍼런스 실측: Claude·Codex 공히 "짧은 창+주간 창" 2게이지+절대 리셋 시각이 사실상 표준. 조회 실패 시 last-known 폴백(Claude). buzz에는 사용량 UI 자체가 없다 — 앞설 수 있는 지점.

## Decisions

### D1. provider_link 복수화 — 순서 있는 체인
- **A (권고)**: `provider_link_chain(id uuid, position int UNIQUE, base_url, bearer(write-only, 기존 암호화 관례), mode, enabled bool)` 신규 테이블(마이그레이션). 기존 싱글톤 `provider_link`는 position=0 항목으로 이전(하위호환 view 또는 이전 스크립트).
- 캐스캐이드 규칙: position 순서로 시도, **무응답/5xx/429만 다음으로 넘어간다**(4xx 검증 실패는 사용자 오류 — 폴백 금지). health probe(기존 /test 재사용)를 체인 전체로 확장.
- **전환은 기록한다**: run 감사행 `provider.cascade.fallback {from, to, reason}` + 카드에 "2차 프로바이더로 처리됨" 표기. 조용한 전환 금지 — 비용·거버넌스가 다른 경로로 흘렀음을 사용자가 안다.
- B — 어댑터 내부에서만 폴백(oort 몰래): 감사 공백. **기각.**

### D2. 잔여량 프로브 — 경계 보존형
- **A (권고)**: 프로브 실행 주체 = hermes adapter(자격증명 보유 측). oort에 신규 ingest: `POST /v1/provider/quota-snapshots` `{provider_ref, window(short|weekly), remaining_ratio, resets_at, probed_at}` — **숫자만, 토큰·헤더 원문 비유입**(ADR-0004 유지). 저장은 최신 스냅샷만(테이블 1개, upsert).
- 대시보드(사용량 섹션 확장): 창별 2게이지 + `{요일 HH:mm} 리셋` 절대 시각 + 스냅샷 나이 표기, 스냅샷 부재/부실 시 **"마지막 확인값" 폴백**(616 기구현 문법 재사용).
- B — oort 서버가 provider API 직접 조회: 자격증명 유입. **ADR-0004 위반, 기각.**

### D3. hermes adapter 다형화
- adapter 런타임에 provider 어댑터 인터페이스(chat/probe/health) 도입, 체인 구성은 oort가 내려준다(base_url+mode 목록). adapter는 자격증명을 자기 설정에서만 읽는다(기존 경계 그대로).

## Consequences
- (+) 캐스캐이드·잔여량 모두 ADR-0004 비유입 불변식 유지. 전환·소진이 전부 가시화.
- (−) 마이그레이션 2건(chain, quota_snapshot) + adapter 개조. 싱글톤 GUI(AiLinkSection·mac 768줄)의 체인 UI 개편 필요.
- 파생(Accepted 시): 엔진 2장(chain 스키마+캐스캐이드 게이트웨이 / quota ingest+REST), adapter 1장, 웹 1장(체인 편집 UI+잔여량 게이지).
