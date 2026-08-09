# 핸드오프 패킷 SRV-B3 — provider 능력 확장: 모델 카탈로그·추론 강도·웹검색 조사

- status: **ready** · worker: Opus 5 (서버) · 기준: `origin/track/engine` 최신 · 새 워크트리 · goal별 브랜치·PR 순차
- 발단: 성재 검수 — *"루나 모델 피커에 luna가 없다(sol만)"* · *"추론 강도에 매우 높음/최대가 없다"* · *"웹검색이 안 된다 — 툴이 필요하면 쥐어줘"*
- 라이브 실측: provider = `external-hermes` → `https://chatgpt.com/backend-api/codex` (ADR-0147 OAuth 등록 완료, account_id 헤더 포함)

## Goal 1 — 모델 카탈로그 + 추론 강도 확장

1. **현황 실측부터**: 모델 피커 어휘의 원천(`allowed-models` REST → 카탈로그/effort 표, `server-rust/crates/momo-agent/src/effort.rs`·`routing.rs`)에서 지금 sol만 노출되는 이유를 확정하라.
2. **luna 계열 추가**: 성재 요구 = 루나에 luna 모델. **백엔드가 실제로 받는 모델 id를 실측**해서(코덱스 백엔드에 잘못된 model을 보내면 어떤 오류가 오는지 포함) 카탈로그에 추가하라. 실측 방법이 없으면 지어내지 말고 "후보 id + 검증 계획"으로 이탈 보고.
3. **추론 강도**: 현 노출 = 낮음/보통/높음. sol 계열은 xhigh(매우 높음)를 실지원한다(이 레포 워커 런들이 `terra xhigh`로 돌았던 역사). `supported_efforts` 표를 모델별 실지원에 맞게 확장하고, 지원 안 하는 모델에 노출하지 않는 fail-closed 유지. UI(웹 피커)는 어휘를 서버에서 받으므로 서버만 고치면 된다 — 라벨 문자열이 클라에 있으면 그 매핑만 확인.
4. 검증: allowed-models conformance + effort 게이트 + openapi 동반 갱신.

## Goal 2 — 웹검색 툴: 조사 선행 (구현은 조사 결과에 따라)

1. **조사**: 이 provider 경로(Responses API 형상, `bins/momo-agent-worker/src/responses.rs`)가 provider 내장 웹검색 툴(`web_search` 류)을 받는지 실측/문서 확정. 코덱스 백엔드가 거절하면 그 증거를 남겨라.
2. **되면**: 툴 카탈로그에 웹검색 추가 설계 — `agent_profile.enabled_tools` 어휘 확장, **승인 정책 판정 포함**(읽기 전용 조회 툴이 tool_call 승인 대상인가? v0 승인 생산자는 work.session.end다 — 웹검색까지 승인을 물리면 대화가 멈춘다. 권고안을 명시하되 결정은 성재/오케스트레이터 몫으로 이탈 보고).
3. **안 되면**: 대안(서버 사이드 검색 프록시 툴 등)의 비용 스케치만 남기고 구현하지 마라.
4. 이 goal은 **조사 보고 PR(문서)** 로 끝나도 된다 — 추측 구현이 최악이다.

## 공통

- 수정 범위: `server-rust/**`(+openapi). 클라·core 금지. schema_v0 금지(마이그레이션 불요일 것).
- 실측에 라이브 서버가 필요하면 **읽기 전용**으로만; 쓰기 실험은 로컬 스택에서.
- 검증: cargo 전체+관련 실DB 스위트+red proof. PR 본문 `## 계획 이탈`. PR 후 STOP.
