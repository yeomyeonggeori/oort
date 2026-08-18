# LIVE-5b 핸드오프 패킷 — 웹 직접 조작 UI (딥링크 진입·입력 포워딩·auto-return·오버레이 설계)

> 2026-08-18 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음.
> 편성 정본: `handoffs/2026-08-17-live-5-direct-control-ux-plan.md`(§4 확정 — 진입점=LIVE-4 딥링크 우선·오버레이는 설계만) · 5a 랜딩분이 서버 전제(engine `c9a390d9` 계열).
> 근거 ADR 전부 Accepted: 0004 증보 3(D2 입력 자격 비관측·D3 비관측)·0165(+증보 1·2).
> 정본 goal: GitHub Issue **#1549**(status:ready — metadata-only binding, 2026-08-18 발급). 수용기준 정본=§4.
> 기준 커밋: **origin/track/engine 최신**(발사 시 fetch). claim: `scripts/goal_claim.sh <n> --base track/engine`(main goal_claim에 #1464 부재 — 명시 필수, 파도 6 교훈).

## 0. 5a가 세워 둔 서버 전제 (전부 랜딩 — 이 goal은 소비만)

- **controller capability**: `mode: "controller"` 요청 시 grant+control 창 개설+에이전트 경로 409+run 파킹(#1425)+**observation→owner_only 강제·반환 시 복원**(원자). owner만.
- **ephemeral TURN**: capability/validate 응답 `ice_servers`(빈 배열=기존 설정 사용 — 오류 아님, openapi 서술 확정).
- **control 내구 투영**: 세션 목록/상세 투영에 control 상태(창 열림·controller·시각) — 리로드 재구성 conformance 완료.
- **경계 이벤트**: `work.session.control` 프레임(정지/재개 시각 — 프레임 자체가 사실, LIVE-4 랜딩).

## 1. 미션 — 네 조각 (전부 웹, 서버 비접촉)

1. **딥링크 진입 + 전환 UI**: LIVE-4 로그인 핸드오프 카드의 "직접 조작으로 이동" 액션 → 세션 상세의 control 시작 경로(controller capability 요청). owner 아닌 사용자·스트림 없는 세션에는 **어포던스 부재**(비활성 버튼 금지 — LIVE-4 문법). framesDecoded>0은 힌트(어포던스 게이팅이 아니라 안내 — contrarian 판정 유지).
2. **입력 포워딩**: controller일 때만 datachannel 개설(view-only=채널 부재 유지 — ADR-0165 D4)·키/마우스 캡처→producer 전송. **입력 내용 비관측 클라 보증**: 캡처된 키가 전사·로그·상태·React devtools 노출 경로에 안 남는 것(메모리 통과만) — 계약 테스트로 고정.
3. **실패 auto-return**: controller 협상 timeout 30s(<lease 90s) 내 명시 반환 REST·producer 크래시/TURN 장애 시 자동 관전 복귀·반환 실패 시에도 lease 90s backstop이 있음을 화면이 정직하게 말함(기다리는 이유 서술).
4. **오버레이 진입점 — 설계만**: 관전 화면 위 "직접 조작" 버튼의 설계 1문단+목업(캡처 픽스처 가능)·구현 여부는 리뷰 판정(§4 확정 — 이 goal에서 코드로 만들지 않음. 만들면 이탈).

## 2. 필독 코드 좌표 (기준 커밋 재확인)

- 관전 스트림: `clients/web/src/features/work/displayStream.ts`(재검증 기계·부재-단언 테스트 `displayStream.test.ts` — controller 시대 문법 갱신 필요 시 정직하게)·`WorkSessionDetail.tsx`(control 투영 소비 — 5a가 세운 필드).
- LIVE-4 카드: `packages/momo-core/src/features/timeline/loginHandoffCard.ts`+웹 렌더(카드 액션 계약 — 신규 액션 발명 금지, 기존 "세션 상세 딥링크" 확장).
- capability API: openapi `display-attach` 계열(5a 갱신분 — `ice_servers`·controller 서술)·web-legacy 생성 타입(openapi 변경 시 재생성 필수 — 파도 6 교훈).
- 실시간: `useWorkSessions.ts`(control 프레임 onControl — LIVE-4 랜딩분 소비).

## 3. 지켜야 할 계약

- **ADR-0004 증보 3 D2**: 입력 자격 비관측 — 클라에서 키 입력이 상태 저장·로그·전사 어느 경로에도 비유입(캡처→datachannel 직송). red proof 필수.
- 서버·스키마·server-rust 비접촉(5a 완결 — 부족 발견 시 정지+이탈). momo-core는 카드 액션·투영 소비 한도 내 가산만.
- 관전(observer) 경로 무회귀 — LIVE-2 랜딩분의 재검증·revocation 기계 재사용(신규 발명 금지).
- design-review Blocker 0/High 0(웹 표면 목표)+momo-design-taste-web 프리플라이트. 네 상태 규율(연결 중·조작 중·반환 중·실패)·정직 카피(배포 사실≠세션 사실 2분법).
- "인수" 단어 금지(증보 3 D1 어휘)·진행/잠금 문법(#1486 정본).

## 4. 수용기준 (정본)

1. 딥링크→controller 전환→실화면 위 입력 UI 도달(모의 시그널링 하네스 — 실호스트는 5c). owner 아닌 자·무스트림 세션=어포던스 부재.
2. datachannel 입력 포워딩+**비관측 red proof**(키 입력이 상태/로그/전사에 남으면 red).
3. auto-return 3경로(timeout 30s·producer 크래시·명시 반환) 계약 테스트+반환 후 observation 복원 표시.
4. 오버레이 설계 1문단+목업(구현 0줄).
5. 웹 스위트·typecheck·프리플라이트·캡처(상태 4종 light/dark)·design-review PASS(B0/H0)·grok freeze.

## 5. 함정

- 템플릿 §5.1 전항. datachannel은 producer가 controller 검증 후 연다(5a 계약) — 클라가 먼저 열려 하면 안 됨(순서).
- `ice_servers` 빈 배열=기존 설정(오류 표시 금지 — openapi 서술 그대로).
- 입력 캡처 중 브라우저 단축키 충돌(전체화면·포커스 이탈)의 정직 처리 — 캡처 범위 서술.
- 관전자였다가 controller가 된 사람의 스트림 전환(재협상 vs 재접속)은 실측 전 단정 금지 — 모의 하네스에서 택한 방식을 정직 라벨.

## 6. 이탈·착수

표준(PR `## 계획 이탈`·`--blocked` 정지). 발사=momo-main이 이슈 번호와 함께.

## 7. 컨텍스트 델타

- 새로 고정: 오버레이=설계만·입력 비관측은 클라 red proof가 수용기준.
- 의도적 미결정: 스트림 전환 방식(워커 실측 제안)·오버레이 구현 여부(리뷰 판정).
- 재기획 트리거: datachannel 계약에 서버 부족 발견 시(5a 증보 필요 판단).
