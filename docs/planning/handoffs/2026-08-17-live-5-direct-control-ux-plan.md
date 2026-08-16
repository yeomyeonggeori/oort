# LIVE-5 편성안 — 실화면 위 직접 조작 UX (E2E 개방 후)

> 2026-08-17 Fable 기안. **성재 발사 결재 대기**(자율 진행 결재 범위이나 규모 L·경계 접점 다수라 편성안 먼저 상신). 예약 스코프 정본: `research/2026-08-16-live4-interview-and-plan.md` §3 + LIVE-4 동결 이월. E2E 실물 실측(#1438) 반영.
> base = track/engine@10c58951(#1455 랜딩 HEAD). 경계: ADR-0004 증보 3(Accepted — control 비관측)·ADR-0165(+증보 1 Accepted·증보 2 Proposed).

## 0. E2E가 확정한 실물 전제 (편성 반영)

- **실화면이 실제로 뜬다**: 외부 브라우저→TURN relay→microVM producer 56프레임@720p 렌더 실증(#1438). LIVE-5는 이 실물 위에서 **관전(observer)→직접 조작(controller) 전환 UI**를 얹는다 — 모의 producer가 아니라 실 파이프라인 대상.
- **relay 강제·ICE base 주입이 producer 계약**(증보 2): LIVE-5 클라의 `DISPLAY_ICE_SERVERS=[]`는 이제 TURN 자격을 채운다(서버가 capability와 함께 TURN 단명 자격 발급 — 정적 자격은 방금 로테이션됨, 단명화가 LIVE-5 범위).
- **control 서버 계약은 전부 랜딩**(LIVE-3·#1425): controller capability(owner 한정)·control 창 원장·비관측 게이트·run 파킹·경계 이벤트. LIVE-5는 그 위의 **웹 소비 UI + 입력 포워딩 + observation 전환**만.

## 1. 미션 — 다섯 조각 (예약 스코프 + 이월)

1. **창 열기 UX**: 관전 라이브 화면 블록에서 "직접 조작 시작"(owner만·라이브 스트림 흐를 때만 — framesDecoded>0 어포던스는 안전장치 아닌 힌트, contrarian 판정) → controller capability 발급 → control 창 개설. LIVE-4 카드/세션 표면과 연동(로그인 핸드오프 카드의 "직접 조작으로 이동" 액션이 여기로).
2. **입력 포워딩**: datachannel 개설(controller일 때만 — view-only는 여전히 채널 부재, ADR-0165 D4)·키/마우스 캡처→producer. **입력 자격증명 비관측**(ADR-0004 증보 3 D2 — 사용자가 치는 비밀번호가 전사·audit·서버 비유입, control 창 동안 에이전트 run 파킹은 #1425가 이미 강제).
3. **observation 전환/복원**: control 시작 시 owner_only 강제(팀원 관전 차단 — 자격 노출 방지)+반환 시 자동 복원. LIVE-2 revocation-도달 기계+LIVE-3 owner 예외 재사용(신규 서버 조각 최소).
4. **실패 auto-return**: controller 협상 timeout 30s(<lease 90s) 내 명시 반환 REST — 해악 지속시간을 "테스트된 숫자"로(researcher AC 1번). producer 크래시·TURN 장애 시 자동 관전 복귀.
5. **세션 표면 control 내구 투영**(LIVE-4 동결 경계): 리로드 후 세션 상세가 control 상태를 그리게 — 3투영 드리프트 가드 vs bare RETURNING의 SoT 결정 포함(LIVE-4가 "어느 읽기가 SoT인가는 세션 표면이 control 표면이 되는 LIVE-5 문제"로 이월).

## 2. 분해 제안 (L이라 서브골 3~4)

- **LIVE-5a (엔진 잔여)**: TURN 단명 자격 발급(capability와 합배치)·control 내구 투영 SoT 결정+마이그(필요시)·observation 전환의 서버 원자성.
- **LIVE-5b (웹 핵심)**: 직접 조작 UI(전환 버튼·입력 포워딩·datachannel)·자격 비관측 클라 보증·실패 auto-return·design-review.
- **LIVE-5c (실기동 E2E)**: momo-cube-host에서 실 입력 왕복(사용자 키→화면 반영)·비관측 mutation 증명(control 중 에이전트 화면 접근 실차단)·runtime-unverified(input delivery) 라벨 해소.
- owner_only owner 예외(LIVE-3 이월)는 5a에 편입.

## 3. 리뷰·규율
각 서브골 폐곡선(Fable→design-review(웹)→grok freeze→PR). 5c는 실호스트 실측(E2E 규율). 경계 접점(자격 비관측·observation 전환)은 ADR-0004 증보 3 정합 검증이 수용기준.

## 4. 성재 결정 큐
1. LIVE-5 발사 여부·분해 승인(5a/5b/5c 순차 vs 병렬).
2. TURN 단명 자격 방식(coturn use-auth-secret HMAC vs 서버 발급 user)·정적→단명 전환 시점.
3. 직접 조작의 사용자 발제 진입점(관전 블록 버튼 vs 로그인 핸드오프 카드 전용 vs 둘 다).
