# 핸드오프 패킷 — 프레즌스 #6 (6a 즉시분 · 6b ADR 승인 후)

> 발주: 2026-08-10 Fable/W-QA4. 상위 편성: `docs/planning/2026-08-10-desktop-qa-feedback-batch1.md` #6. 결정 정본: **ADR-0160**(사용자 프레즌스, Proposed).
> 이 패킷은 **초안**이다. **6a**는 ADR 없이 가능한 순수 프론트 이동(성재 “즉시분 착수” 신호 시 발사). **6b**는 **ADR-0160 Accepted** 이후에만 착수한다(구현 금지 게이트).
> **UI 하드룰**: 착수 워커는 시작 시 `momo-design-taste`(웹=`momo-design-taste-web`) 로드. 자체 design-review 금지 — 머지 전 오케스트레이터가 design-review 에이전트 별도 실행(Blocker 0). 4상태·포커스·키보드 준수. 폰(clients/mobile) 범위 밖.

---

## 어휘 고정 (혼동이 이 피드백의 절반이다)

ADR-0160의 세 어휘를 그대로 쓴다. 섞으면 6a가 프레즌스 작업으로 오인된다.

| 어휘 | 무엇 | 이 패킷에서 |
|---|---|---|
| **① 연결 상태(자기)** | 내 클라가 서버에 붙어 있나 — 클라 로컬 | **6a가 옮기는 대상.** 프레즌스 아님 |
| **② 가용성(타인)** | 남이 접속해 있나 — 휘발 | 6b |
| **③ 선언 상태(의도)** | 남/나의 away·dnd — 내구 | 6b |

**6a는 ①의 자리만 옮긴다.** 서버·API·실시간을 하나도 건드리지 않는다.

---

## 6a — 연결 상태 표시를 하단 프로필 패널로 이동 (즉시·순수 프론트·ADR 불요)

### 현황 (실측)
- **연결 표시는 8px 점**이고 `WorkspaceRail`(좌측 32px 워크스페이스 레일) 안에 있다 — `clients/web/src/features/sidebar/WorkspaceRail.tsx:63-75`(`data-testid="conn-status"`). 소켓 상태(connecting/connected/disconnected)를 표시하며 장식이 아니다.
- 라벨은 `connectionCopy()`(`WorkspaceRail.tsx:10-14`): `"실시간 연결됨"` / `"연결 중"` / `"연결 끊김, 재연결 중"`.
- 미는 상태는 `useSession().connStatus: RealtimeStatus`(`"connecting"|"connected"|"disconnected"`). 별도 reconnecting은 없다(최초 연결 후 끊김은 전부 disconnected로 접힘 — `clients/web/src/lib/realtime.ts:130-146`).
- 목적지 = **하단 프로필 패널** `Sidebar.tsx:507-526`(첫 글자 아바타 + 이름 + 설정 톱니). **상태 어포던스 없음.**
- **배선 이미 있음**: `Sidebar`가 `connStatus`를 스코프에서 읽는다(`Sidebar.tsx:112` `const { session, workspaceId, connStatus } = useSession();`) — 새 prop/컨텍스트 불요. 그대로 하단 패널에 넘긴다.

### 이동이 안전한 이유 (핵심 판정 — 의미 보존)
연결 표시에는 **두 표면**이 있고, 실무상 무거운 쪽은 점이 아니라 배너다:
- **점(ambient)** = WorkspaceRail 안. “다 정상 / 연결 중”의 저소음 신호.
- **배너(load-bearing)** = `ConnectionBanner`, **셸 레벨에서 항상 마운트**(`clients/web/src/app/AppShell.tsx:227`). design-system §4의 오프라인 상태(“인라인 배너 하나(WS 끊김)”)가 이것이다. 끊김이라는 **유일하게 중요한 상태**는 사이드바와 무관하게 배너가 덮는다.
- 게다가 현재 점의 집(WorkspaceRail)과 목적지(하단 패널)는 **같은 `sidebar-drawer` 안**이다(`Sidebar.tsx:279-287`의 rail, `:507`의 패널). 즉 이동해도 점의 **가시성 등급이 바뀌지 않는다**(좁은 뷰포트에서 드로어가 닫히면 둘 다 안 보이던 것 → 여전히 그렇고, 그 상태는 배너가 덮는다).

∴ 점을 레일에서 프로필 패널로 옮겨도 **끊김 신호는 어느 뷰포트에서도 사라지지 않는다.** 이것이 “의미 보존”의 실체다.

### 설계 (구현 세부는 워커 실측 후 확정 — 아래는 의도·제약)
1. **점 + 라벨을 하단 프로필 패널로 이동.** WorkspaceRail의 점을 제거하고, `Sidebar.tsx:507-526` 행에 연결 표시를 둔다. 프로필 패널은 “내가 누구인가”의 자리라 “내가 붙어 있는가”가 의미적으로 더 맞는 집이다.
2. **문자열·접근성 이름은 재사용, 포크 금지.** `connectionCopy()`를 그대로 쓴다(별도 문자열 만들지 말 것). `title`/`aria-label`을 유지해 스크린리더가 상태를 읽게 한다. 색은 토큰(`bg-ok`/`bg-warn`/`bg-danger`)만.
3. **`connStatus` 결속 유지 — 절대 장식화 금지.** 점의 색/라벨은 언제나 `connStatus`에서 파생. (design-system: 실상태 없는 장식 dot = AI-tell.)
4. **`data-testid="conn-status"`를 새 위치로 함께 옮긴다** — 기존 테스트가 표시를 따라오게. 좁은 뷰포트에서 프로필 행이 이름을 truncate하되 점이 밀려나지 않도록(viewport 규칙, 긴 이름).
5. **6b를 위한 seam을 남긴다.** 하단 패널은 장차 ①연결 상태와 ③자기 선언 상태 컨트롤(“상태 바꾸기: away/dnd”)을 함께 담는다. 이번 이동에서 아바타/이름 옆에 **선언 상태 컨트롤이 나중에 무리 없이 들어갈 자리**(예: 아바타를 클릭 타깃으로, 또는 인접 버튼 슬롯)를 비워 둔다. 6b에서 재작업이 없게. **단 6a에서는 ③을 구현하지 않는다**(레이아웃 여지만).

### 결정 포인트 (design-review/성재 판단)
- **레일 점을 완전히 제거 vs 축소 유지.** 권고: **완전 이동**(위 안전성 논증에 따라 배너가 끊김을 덮으므로 이중 표시는 불필요). 이견이 있으면 “레일에 최소 점 + 패널에 라벨”의 이중안도 가능하나, 그건 “이동”이 아니라 “추가”라 카피/중복 위험이 있다 — design-review에서 결정.

### 산출·수용기준 (구현 티켓 뼈대)
- 연결 표시가 `Sidebar.tsx:507-526` 프로필 패널에 렌더되고 `connStatus`에 결속(색·라벨·aria).
- 세 상태(connecting/connected/disconnected)가 각각 올바른 토큰·`connectionCopy` 문자열로 표시.
- WorkspaceRail에서 점 제거(또는 결정된 이중안), 잔존 참조 0 grep.
- 6b용 선언 상태 컨트롤 자리(빈 slot)가 레이아웃에 확보됨(주석 근거).
- **검증**: 웹 스위트 + `scripts/design_preflight_web.sh`(하드 제로) + **red proof**(표시를 `connStatus`에서 떼거나 위치를 되돌리면 테스트 빨강) + **design-review 에이전트(Blocker 0)**. 4상태·긴 이름·좁은 뷰포트 캡처.
- 코드 0줄이 아님 — 이건 **구현** 패킷. 발사는 성재 “즉시분(6a) 착수” 신호 후.

---

## 6b — 프레즌스 모델 신설 (ADR-0160 Accepted 이후에만)

> **게이트**: ADR-0160이 **Accepted**이기 전에는 착수 금지. DND↔푸시 소비는 ADR-0120 푸시 랜딩에도 의존. 아래는 로드맵 스케치이지 발사 지시가 아니다.

### 서버 (ADR-0160 D1·D2·D4·D5)
- **선언 상태(③, 내구)**: `member`에 `presence_status ENUM('auto','away','dnd') DEFAULT 'auto'` 신규 numbered migration(`schema_v0.sql` 불변). `PUT /v1/workspaces/:ws/presence`(본인·`require_human`) → PG → `emit_outbox(Broadcast, no-version)` → relay → 그 멤버의 `ch:` 채널들로만 팬아웃. roster `GET`에 각 보이는 멤버의 `presence_status` projection 추가(부팅 점등).
- **가용성(②, 휘발)**: `EphemeralSignal`에 새 봉인 변형 `Presence`(선호) — 기존 ephemeral 라이터(`momo-ephemeral`) + no-DB 빌드 단정(`ephemeral_*_touches_no_pg`) 상속. 소스=연결 edge(서버는 유휴 타이머 미보유). 대안(Centrifugo presence 직접 소비)은 ADR-0160 기각 D 참조.
- 새 발행 경로 0개(내구=기존 outbox, 휘발=기존 ephemeral 변형).

### 클라이언트 (ADR-0160 D3)
- **유효 프레즌스** = f(선언, 가용성): dnd 우선 → away → auto면 가용성(online/offline). **저장 안 함, 렌더 경계 계산.**
- 로스터/멤버 표면에 프레즌스 점(실상태 없으면 점 없음 — 장식 금지).
- **자기 선언 상태 컨트롤**을 하단 프로필 패널(6a가 남긴 seam)에 배치 — away/dnd 설정.
- **DND→푸시**: NotifierWorker가 `presence_status=dnd`를 소비해 억제(ADR-0120 티켓, 푸시 랜딩 뒤).

### 미결 (ADR-0160 §미결 승계)
가용성 소스 확정 · enum 최종 어휘 · auto-away 채택/값 · 발행 케이던스·멀티기기 coalescing · 저장 위치(워크스페이스별 vs 전역 — ADR-0117 미실현). 전부 구현 배치가 판단해 PR에 적립.

### 검증 계약
ADR-0160 §검증 계약 1~7을 티켓 수용기준으로 승계(actor binding·팬아웃 로스터 봉인·PG 무접촉 단언·유효값 무저장·RLS 경계·장식 dot 금지).

---

## 보고 요약 (W-QA4)
- ADR: **ADR-0160**(사용자 프레즌스) **Proposed** 기안 완료. 2계층(가용성=휘발/구독형 · 선언상태=내구/단일쓰기경로) + 유효값 렌더 계산 + 사람 전용. **새 발행 경로 0개**(ADR-0149 ephemeral 경로가 이미 구현·출하 → 선례이자 재사용처).
- 6a: **즉시 착수 가능**(순수 프론트, `connStatus` 배선 이미 존재, 끊김은 셸 배너가 덮어 이동 안전). 성재 “즉시분 착수” 신호 대기.
- 6b: **ADR-0160 Accepted + 푸시 랜딩** 게이트. 착수 금지.
