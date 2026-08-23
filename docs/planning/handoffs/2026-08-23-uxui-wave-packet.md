# UXUI 완성도 파도 통합 패킷 — 배치 1 (U-1·U-2·M-1)

> Status: `ready` · Planning ID: `PLN-20260823-UX` · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-23 · 기준: `track/uxui@7c95bddf` · 계획 정본: `docs/planning/research/2026-08-23-uxui-completeness-wave-plan.md`(감사 실측 §1)
> GitHub binding: U-1=#1679 · U-2=#1680 · M-1=#1681 (배치 2: C-1·U-3·U-4·U-5·M-2(ADR 게이트)·U-7 — 배치 1 랜딩 후 발급)
> 워커: **sol(codex) 병렬 3** — 성재 지시(2026-08-23: "구현 작업은 grok4.6 대신 sol 워커로") · 검수: Fable + design-review 에이전트(fresh context, Blocker 0)
> 발사 근거: 성재 지시문 자체("구현계획 구체화하고 구현해줘")

## 0. 전제 — 이 파도가 아닌 것

감사(계획 정본 §1)가 확정했다: 리액션·스레드·수정/삭제·핀·호버 메뉴·타이핑·안읽음 구분선·첨부(웹)·마크다운은 **이미 있다**. 워커는 이들을 재발명하지 않는다 — 기존 표면에 **합류**한다. 겹치는 구현을 발견하면 새로 만들지 말고 기존 것을 재사용하고, 재사용이 불가능한 구조면 이탈 보고.

## 1. 충돌 매트릭스 (병렬 3의 근거)

| goal | 접촉 파일군 | 상호 충돌 |
|---|---|---|
| U-1 #1679 | `clients/web/src/features/timeline/`(MessageRow·MessageActions)+프로필 카드 신규+`design/ui/` 프리미티브 | U-2와 0 (U-2는 ChatShell 헤더·channels) |
| U-2 #1680 | `clients/web/src/features/chat/ChatShell.tsx`(헤더부)·`features/channels/` | U-1과 0 — **MessageRow·MessageActions 비접촉 하드 룰** |
| M-1 #1681 | `clients/mobile/` 전용(+`packages/momo-core` 소비 시작은 읽기만) | 웹 트리 비접촉 |

공통 접촉 위험: `packages/momo-core` — **이번 배치는 코어 수정 금지**(멘션 노드는 C-1이 단독 랜딩). 코어 수정이 필요해 보이면 정지·이탈 보고.

## 2. 규율 (3 goal 공통)

- 오르트 구름 정본(`docs/design-system/README.md`): 토큰만(§2 — 웹 `tokens.css`·폰 `tokens.ts` 팔레트 2벌), 스케일 밖 값 금지, 4상태(빈·로딩·오류·오프라인) 의무, 위계=관계(§3), 죽은 컨트롤 금지, 토스트 금지(문장은 그 자리에).
- 웹: Esc 층(`design/ui/escapeLayer.ts`) 합류·포커스 반환·로빙 포커스(`data-row-action`) 존중. R1 M8 회귀 금지(메시지 행 탭스톱 증가 0).
- 폰: TOUCH_TARGET=44·SAFE_GUTTER=16·`buildStyles(palette)` 관례·신규 네이티브 의존성 금지(ADR-0137 D1).
- 프리플라이트: 웹=`scripts/design_preflight_web.sh`, 커밋 전 관련 테스트+게이트 로컬 실행. docker 필요 게이트는 오케스트레이터 몫 — 시도 말고 보고.
- worker는 **merge/close 금지·PR 생성 후 정지**. 시크릿 커밋 금지. `schema_v0.sql` 비접촉. 스코프 확장 금지(발견은 PR 본문 「발견」 절에 원장화).
- PR 본문: 변경 요약·실측 증거(테스트/캡처)·이탈(있으면)·발견. UI 캡처는 `clients/web/scripts/capture-screens.mjs`/폰 measure 하네스 활용 가능하면 첨부.

## 3. goal별 계약

계약 전문은 각 이슈 본문이 정본이다(#1679·#1680·#1681 — 사실 좌표·작업·AC 포함). 이 패킷은 배치 규율과 충돌 경계를 묶는다.

- **U-1**(#1679): 우클릭 ContextMenu(선택 시 네이티브 양보)+메시지 복사(3경로)+멤버 프로필 카드(아바타=로빙 포커스 합류·디렉터리·DM 헤더 진입). 결정 기록 2곳(MessageRow.tsx:530-531·tokens.css:855-857) 문면 갱신 포함.
- **U-2**(#1680): 채널 토픽 표시(+가능하면 편집 — 서버 라우트 실측 선행, 없으면 축소 이탈 보고)+헤더 멤버 목록 팝오버+인원수 버튼화. MessageRow 비접촉.
- **M-1**(#1681): 첨부 렌더+다운로드(조용한 유실 버그 폐쇄·회귀 단정 필수)+사람 프로필 시트. 사진 picker는 범위 밖(M-2).

## 4. 검수·랜딩 (오케스트레이터)

worker PR → Fable diff 리뷰+실검증 → design-review 에이전트(fresh·실렌더) Blocker 0 → track/uxui 순차 머지 → 잔재 회수. main 승격은 성재 게이트(TRACKS §3). 성재 검수 빌드는 항상 트랙 워크트리 빌드("빌드 원본" 고지).
