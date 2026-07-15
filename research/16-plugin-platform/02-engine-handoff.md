# 16-02 · Fable 엔진 세션 핸드오프 — 플러그인 플랫폼 구체화

> 용도: 성재가 별도 Fable 세션에 "플러그인 플랫폼 추가 리서치·구체화"를 위임할 때 이 문서 하나로 착수 가능하게. 2026-07-16 · 기준: main 최신 + `research/16-plugin-platform/00·01`

## 착수 시 읽는 순서

1. `research/16-plugin-platform/01-momo-plugin-platform-proposal.md` — 결론과 경계 (5분)
2. `research/16-plugin-platform/00-ecosystem-survey.md` — 근거 사실과 [미확인] 표기 (10분)
3. `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md`의 ADR-0113 절(§72~)과 SE-04A/04B 절(§285~) — 이 위에 얹는다
4. `research/13-redesign/03-google-workspace-files-rag.md` — Drive 동결 트랙과의 관계(01 §4)

## 확정으로 간주해도 되는 것 (재조사 불요)

- 업계 3층 표준 수렴(MCP+SKILL.md+plugin.json/marketplace.json), Codex의 CLAUDE_* 호환 유지 — [1차] 검증 완료.
- MCP authorization 스펙(OAuth 2.1/PRM/DCR/resource/passthrough 금지)과 "토큰 보유 주체=MCP 클라이언트" — 스펙 전문 확인.
- 커스터디 권고 (B)+(C): 에이전트 호스트=클라이언트, 벤더 remote 우선, momo 서버는 카탈로그·정책·감사 전용 — momo 불변식과의 정합 논증은 01 §1.
- 원클릭 설치의 실체 4단계, ChatGPT 워크스페이스 정책 모델(기본 비활성·role 스코프), 동적 발견의 도구 폭발 해법(지연 로드+검색).

## 1순위 작업: [미확인] 실검증 (ADR-0113 draft 인용 전 필수)

1. 후보별 공식 MCP 서버: github-mcp-server·notion-mcp-server **라이선스 실물**, GitHub/Notion/Linear **호스티드 remote 엔드포인트와 OAuth 방식**(커스터디 옵션 C의 성립 조건).
2. **Google Workspace MCP 2026 현황**: 공식 서버 존재 여부, Drive `drive.file` 최소 스코프 전략, OAuth 앱 검증(CASA) 요건 — 1호 플러그인의 실현 경로 결정.
3. Mattermost 마켓플레이스 실검증(manifest·관리자 설치 모델·Apps Framework 지원종료 여부) — 서버 단위 관리 UX 비교 대상.
4. Codex 플러그인 디렉터리 "추천/featured" 편성 기준 제품 관찰(문서 미기재).

## 2순위 작업: ADR-0113 draft 기안 (engine planner 몫)

- 01 §1 커스터디 권고 + §4 Drive 모드 A 우선 + 에이전트 호스트 토큰 보유의 신뢰 경계(다중 사용자 워크스페이스에서 토큰 소유자 명시)를 Options로 구조화.
- (A) 서버측 보관 모델을 기각이 아닌 명시 Option으로 두고 ADR-0004 경계 변경 비용을 적시(성재가 트레이드오프를 보고 결정).
- SE-04A 계약 확장(3층 manifest·momo 확장 필드·server.json 참조·추천 세트 정책 필드)을 파생 배치로.

## 경계 (변경 금지)

- 구현 금지 — ADR-0113/0115 Accepted 전. GPL/AGPL 백본 금지. momo 서버 코드 실행·토큰 보관 금지(결정 전).
- UX/UI(`clients/macOS`)는 momo-main 트랙 소유 — **Codex의 플러그인 UI handoff 문서가 도착하면 01 §5 UX 계약과 대조**하고, 화면은 UX 트랙·registry/정책/감사 API는 엔진 트랙으로 분담. UI handoff 위치는 성재에게 확인.
- 기존 ID 재사용 금지(MOMO-300~323 소진, 신규 티켓은 400번대 현황 확인 후), ADR 번호는 0123+ 또는 기존 0113/0115 안에서.

## 진행 문맥 (2026-07-16 시점)

- 웹 트랙: MOMO-389/390/391/398/399/400 종결, 401(초대 웹 합류)만 남음. 푸시 P-1/P-2는 그 뒤.
- ADR-0122(음성 허들) Proposed — 성재 승인 대기.
- UX 트랙(momo-main·5.6 sol): MOMO-392~397 발급분 진행 중 — 스레드(393)·첨부(394)·presence(395)가 엔진 큐(ADR-0104/0113/0116)와 맞닿음, 크로스트랙 노트는 JOURNAL 2026-07-15 참조.
