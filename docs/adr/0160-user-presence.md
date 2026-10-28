# ADR-0160: 사용자 프레즌스 — 가용성은 휘발, 선언 상태는 내구, 유효값은 계산

- Status: **Accepted** (2026-08-10 · 기안 Fable/W-QA4 · 성재 승인 2026-08-10 검수 배치 2)
- 관련: **하드 불변식**(Postgres=SoT · Centrifugo 전송전용 · 단일 쓰기경로 · transport carries never authors · 에이전트=member · RLS FORCE), **ADR-0149**(휘발 신호 — 이미 구현·출하된 두 번째 발행 경로, 이 결정의 직접 선례), **ADR-0109**(read-state — 내구 per-member 필드 + outbox 브로드캐스트의 선례), ADR-0110·0128(roster 가시성 = 프라이버시 경계), ADR-0120(푸시 — DND의 소비처), ADR-0117(멀티 워크스페이스 미실현 — 전역 identity 부재), ADR-0145(Rust). UX 바이블 **P14**(프레즌스=가장 비싼 트래픽 → "보이는 유저만 구독")·P8·P9(알림 판정 단일화).
- 발단: 성재 데스크탑 검수(oort.app) 피드백 #6 — *"좌하단 상태칩을 프로필로 옮기고 사용자 상태를 바꾸게"*. 조사 판정: **좌하단 표시는 사용자 상태가 아니라 소켓 연결 상태**이고, 프레즌스는 서버 필드·API·실시간 프레임 전 계층에 전무하다.
- 큐 관계: 결정 큐의 **ADR-0104**(“에이전트 presence/typing/streaming 이벤트”, `queued`·미기안)는 세 가닥을 뭉뚱그린 자리였다. **타이핑**은 ADR-0149로 이미 구현됐고, **에이전트 작업 신호**는 `agent_run` 상태(+`agent:`)가 담당한다(MOMO-350). 남은 **사람 프레즌스** 가닥을 #6이 드러냈고, 이 ADR이 그것을 결정한다. 0104 슬롯의 형식적 폐기·정리는 성재/`momo-main`의 몫이다(이 PR은 정본 큐를 건드리지 않는다).

## 왜 ADR인가 — 순진하게 만들면 불변식·프라이버시·스키마를 동시에 건드린다

프레즌스는 메신저의 기본기지만 세 경계에 동시에 닿는다: **실시간 발행 경계**(새 신호), **프라이버시**(누가 누구의 상태를 보는가), **내구 상태**(멤버 테이블 신규 컬럼). 경계 변경은 Accepted ADR 없이 머지 금지(ADR-0100). 그리고 UX 바이블 P14가 경고하듯 프레즌스는 **가장 비싼 ambient 트래픽**이라, 발행 문법을 처음부터 잘못 잡으면 규모가 조금만 커져도 서버가 프레즌스 중계에 CPU를 다 쓴다(Slack·Discord가 공개 인정한 실패, `docs/architecture/bible/01·03·04`).

## 실측 — 지금 무엇이 있나

| 사실 | 근거 |
|---|---|
| **좌하단 “칩”은 8px 연결 상태 점**이고 소켓 상태(connecting/connected/disconnected)를 표시한다. 사용자 상태가 아니다 | `clients/web/src/features/sidebar/WorkspaceRail.tsx:63-75` (`data-testid="conn-status"`), 라벨 `connectionCopy()` `:10-14`("실시간 연결됨"/"연결 중"/"연결 끊김, 재연결 중") |
| 그 점을 미는 상태는 `useSession().connStatus: RealtimeStatus`(`"connecting"\|"connected"\|"disconnected"` — **별도 reconnecting 없음**, 최초 연결 후 끊김은 전부 disconnected로 접힘) | `clients/web/src/app/AppShell.tsx:55·153-156`, `clients/web/src/lib/realtime.ts:130-146` |
| 하단 프로필 패널(`Sidebar.tsx:507-526`)에는 **상태 어포던스가 없다** — 첫 글자 아바타 + 이름 + 설정 톱니뿐 | `clients/web/src/features/sidebar/Sidebar.tsx:507-526` |
| **프레즌스 전무** — 서버 필드·set/read API·실시간 프레임 어디에도 없다 | server-rust·web 전수 grep 0건(무관한 `CloudInstancePresence`·huddle occupancy 제외) |
| Centrifugo **presence/join_leave는 이미 켜져 있으나 소비하는 코드가 없다** | `infra/prod/centrifugo.prod.json` — `ch`·`dm`·`agent`에 `presence:true`(ch·agent는 `join_leave`도). 앱 코드 소비 0건 |
| **선언 상태를 담을 자리가 스키마에 없다** — 전역 user 테이블이 없고 identity는 워크스페이스별이다. `member.status`는 **수명주기** enum(`active/invited/suspended/deleted`)이지 프레즌스가 아니다. `online/away/dnd/last_seen` 컬럼 없음 | `schema_v0.sql:12·45-57`, `server/Migrations/001_init.sql:12` |
| **ADR-0149의 휘발 발행 경로는 이미 구현·출하됐다** — 두 번째 Centrifugo 라이터(`EphemeralPublisher`), 봉인 enum, `history_size:0` 네임스페이스, HMAC grant, no-DB 빌드 단정까지 | `server-rust/crates/momo-ephemeral/src/publisher.rs:84-119`, `signal.rs:136-139`(enum 1변형 `Typing`), `routes/ephemeral.rs`, `tests/ephemeral_typing_touches_no_pg.rs` |
| 단일 쓰기경로의 outbox INSERT 병목은 하나뿐(`emit_outbox`), 내구 발행 라이터도 하나뿐(relay) | `server-rust/crates/momo-outbox/src/emit.rs:63-89`, `bins/momo-relay/src/centrifugo.rs:65-99` |
| 실시간 연결 토큰은 **채널을 하나도 grant하지 않는다**. per-channel 권한은 별도 subscribe 프록시가 멤버십으로 판정한다(`typing`도 `ch` 규칙에 접힘) | `routes/realtime.rs:84-149`(issue_token), `:206-253`(parse_channel), `POST /v1/centrifugo/subscribe` |

마지막 세 줄이 이 결정을 싼 것으로 만든다: **새 발행 경로를 뚫을 필요가 없다.** 내구 상태는 기존 outbox가, 휘발 상태는 이미 승인·구현된 ephemeral 라이터가 나른다.

## 세 어휘를 분리한다 (이 ADR에서 가장 먼저 못박을 것)

“상태”는 momo에서 세 가지 다른 물건이고, 각각 다른 불변식 처리를 받는다. 섞으면 #6이 정확히 그 혼동이다.

| 어휘 | 무엇인가 | 소유·저장 | 예 |
|---|---|---|---|
| **① 연결 상태(자기)** | *내 클라이언트가 서버에 붙어 있나* — 클라 로컬 사실, 타인 데이터 없음 | 클라 상태 `connStatus`, 서버 무관 | connecting/connected/disconnected (WorkspaceRail 점) |
| **② 가용성(타인)** | *이 사람의 클라이언트가 지금 접속해 있나* — 전송이 이미 아는 사실 | **휘발**. PG 미접촉 | online / offline |
| **③ 선언 상태(의도)** | *이 사람이 스스로 무엇으로 보이길 택했나* | **내구**. `member` 신규 컬럼 | auto / away / dnd |

**①은 프레즌스가 아니다.** #6의 6a(칩 이동)는 ①의 자리만 옮기는 순수 프론트이고, 이 ADR을 기다리지 않는다(별도 패킷). 이 ADR은 ②·③, 그리고 화면에 실제로 찍히는 **유효 프레즌스**를 결정한다.

## 결정 (Proposed)

### D1. 가용성(②)은 휘발이고 PG를 절대 건드리지 않는다
online/offline은 **상태가 아니라 신호**다 — 서버가 재시작하면 사라지는 게 맞고(ADR-0149와 동일 논리), 연결 채널(붙었다/끊겼다/멀티기기/네트워크 깜빡임)은 타이핑보다 잦은 고빈도 축이다. 이걸 PG에 쓰면 ADR-0149가 거부한 “타이핑을 outbox에” 반패턴을 연결 규모로 재현한다. 가용성은 **전송이 이미 소유한 사실**(Centrifugo presence가 이미 켜져 있다)이며, 필요하면 **기존 ephemeral 라이터의 새 봉인 변형**(`EphemeralSignal::Presence`)으로 발행한다. 새 subsystem이 아니다.

### D2. 선언 상태(③)는 내구이고 단일 쓰기경로로만 바꾼다
away/dnd는 **사용자 의도**이고 재접속에 살아남아야 한다. 특히 **DND는 알림을 억제**한다(P8·P9·ADR-0120) — 서버 권위·내구가 아니면, 재접속이 조용히 DND를 풀고 사용자를 다시 깨운다(버그). 따라서:
- `member`에 신규 컬럼 `presence_status`(제안 어휘 `ENUM('auto','away','dnd') DEFAULT 'auto'`, 신규 numbered migration — `schema_v0.sql` 불변)를 둔다. `'auto'`는 “수동 오버라이드 없음”이며, **`active`를 쓰지 않는다**(수명주기 enum과 충돌).
- `PUT /v1/workspaces/:ws/presence`(본인만·`require_human`) → PG 커밋 → `emit_outbox(Broadcast)` → relay → Centrifugo. **저빈도**(하루 몇 번)라 outbox가 정합적이다(타이핑과 달리).
- `GET`(roster projection)이 보이는 각 멤버의 `presence_status`를 함께 실어, 갓 접속한 클라가 부팅 시 남의 선언 상태를 안다(ADR-0109 벌크 GET과 동형).

이것은 read-state(ADR-0109)와 거의 같은 모양이되 **브로드캐스트 대상이 다르다**: read-state는 프라이버시상 본인에게만(`user:read-state#<member>`), 선언 상태는 **같은 채널을 공유하는 동료(co-member)에게** 나간다 — 보이는 것이 프레즌스의 목적이므로. 팬아웃은 그 멤버가 속한 `ch:` 채널들로 한정되고, 이는 메시지 브로드캐스트가 채널 멤버에게만 닿는 것과 같은 로스터 경계다.

### D3. 유효 프레즌스는 저장하지 않는다 — 읽기/렌더 경계에서 계산한다
화면 점 = 두 입력의 순수 함수, **비정규화 컬럼 없음**(드리프트할 자리를 만들지 않는다):
- 선언 = **dnd** → dnd (접속 중이어도 표시. “지금 핑 금지”라는 의도)
- 선언 = **away** → away
- 선언 = **auto** → 가용성: 접속 → **online**, 아니면 **offline**
- (auto-away — N분 유휴 후 away로 뒤집기 — 는 ADR-0149 타이핑과 같은 만료 규율의 **클라 파생**이다. 서버는 유휴 타이머를 들지 않는다. v0 채택 여부는 미결.)

### D4. 프레즌스는 사람 전용이다
에이전트(=member, kind=agent)는 사람 프레즌스가 없다. 에이전트의 생존감은 `agent_run`(「작업 중」)이 이미 내구로 담고 `agent:`가 표면화한다. 에이전트에 online 점을 다는 것은 봇 래핑(ADR-0101 거부)이다. set 라우트는 `require_human`(타이핑 grant와 동일), enum에 에이전트 의미는 없다. **사람은 온라인/작성 중, 에이전트는 작업 중** — 다른 말이어야 한다(`signal.rs:104`가 이미 못박은 규율의 확장).

### D5. 구독은 로스터 경계로 봉인한다 (P14)
프레즌스는 **처음부터 “보이는 유저만”** 문법이다. 전역 브로드캐스트로 시작해 규모에서 후퇴하지 않는다.
- 가용성(②) 구독은 기존 subscribe 프록시의 채널 멤버십 검사를 재사용한다(`routes/realtime.rs` `parse_channel`이 `typing`을 `ch` 규칙에 접은 것과 동형). guest는 채널을 공유하는 멤버만 본다.
- 선언 상태(③) outbox 팬아웃은 그 멤버의 `ch:` 채널들로만 나간다 = 정확히 동료 집합.

## 왜 이 모양인가 (기각한 대안과 함께)

- **기각 A — 전부 휘발(dnd까지).** DND가 재접속에 사라지면 알림 억제가 조용히 풀린다. “오늘 밤은 핑 금지”가 랩탑이 잠들 때 증발하면 기능이 아니라 버그다. **의도는 내구여야 한다.**
- **기각 B — 전부 내구(heartbeat가 online/offline을 PG에 씀).** 연결 규모의 고빈도 신호를 outbox에 태우는 것은 ADR-0149가 거부한 것을 더 나쁘게 재현하고, Centrifugo가 이미 유지하는 연결 테이블을 중복한다. **가용성은 전송 파생으로 남는다.**
- **기각 C — 전역 브로드캐스트 프레즌스.** O(N²) 팬아웃 — 바이블(03·04)·P14가 지목한 Slack/Discord 실패. **구독 문법이 D5.**
- **기각 D — 클라가 Centrifugo presence를 직접 읽어 상태까지 표시.** Centrifugo presence는 **연결만** 알지 의도(away/dnd)를 모른다. 그리고 전송 내부를 클라에 노출하는 것은 우리가 read-state·메시지에서 하지 않는 방식이다. 가용성의 **소스**로 Centrifugo presence를 쓸 수는 있으나, 서버 seam을 거쳐 선언 상태와 합성한다 — 클라가 유효 점을 위해 Centrifugo presence를 직접 소비하지 않는다.
- **채택 E — 2계층(가용성=휘발/구독형 · 선언상태=내구/단일쓰기경로) + 유효값은 읽기 경계 계산 + 사람 전용.** **새 발행 경로 0개**: 내구는 기존 outbox Broadcast, 휘발은 이미 승인·구현된 ephemeral 라이터의 새 봉인 변형.

## 가드 (이 결정이 새는 것을 막는 것)

1. **선언 상태는 단일 쓰기경로로만.** `member.presence_status` 컬럼은 REST→PG→`emit_outbox(Broadcast)`→relay로만 바뀐다. 내구 상태에 두 번째 쓰기 seam을 만들지 않는다.
2. **가용성은 PG 무접촉.** online/offline write 0. ephemeral 변형으로 발행하면 봉인 enum + no-DB 빌드 단정(`ephemeral_*_touches_no_pg`)을 그대로 상속한다.
3. **유효 프레즌스는 컬럼이 아니라 계산.** f(선언, 가용성)을 렌더/읽기 경계에서만. 두 입력과 어긋날 비정규화 값을 저장하지 않는다.
4. **사람 전용·enum 봉인.** set 라우트 `require_human`. enum = {auto, away, dnd} — `active`(수명주기 충돌)·에이전트 의미 없음. 새 상태 추가 = enum diff = 리뷰에 걸림.
5. **구독=로스터 경계 봉인.** 가용성 구독은 subscribe 프록시 멤버십 검사를, 선언 outbox는 `ch:` 팬아웃을 재사용한다. 프레즌스는 **보는 사람이 이미 보는 로스터 밖으로 절대 발급되지 않는다.** ← ADR-0149의 RLS 주의와 같은, 가장 깨지기 쉬운 자리: PG를 우회하는 가용성 경로는 발행/발급 시점에 구독 권한을 **직접** 재검사해야 한다(타이핑 grant가 하는 그대로).
6. **자기 연결 상태(①)는 프레즌스가 아니다.** WorkspaceRail 연결 점을 프레즌스 신호에 접지 않는다. 별개 클라-로컬 어휘로 유지한다(6a는 이 점의 자리만 옮긴다).

## 불변식 대조

| 불변식 | 판정 |
|---|---|
| Postgres = SoT | **유지** — 선언 상태는 PG 내구. 가용성은 상태가 아니라 신호(재시작하면 사라지는 게 맞다) |
| 단일 쓰기경로 | **유지** — 선언 상태는 REST→PG→outbox→relay 하나. 가용성은 아무것도 쓰지 않는다 |
| Centrifugo = 전송전용 | **유지** — 선언 상태는 기존 relay, 가용성은 ADR-0149가 이미 승인한 두 번째 라이터의 새 변형. **새 라이터 0개** |
| gapless `message.seq` | **유지** — 프레즌스는 seq를 소비하지 않는다(선언 상태 Broadcast는 read_state·work.session류 no-version projection) |
| 에이전트 = member | **유지** — 프레즌스는 사람 전용. 에이전트는 `agent_run` 생존감 유지 |
| RLS FORCE | **주의** — 가용성 경로는 PG를 우회하므로 RLS가 격리를 강제하지 않는다. **구독 권한 검사를 발행/발급 시점에 직접** 해야 한다(가드 5, 가장 깨지기 쉬운 자리) |

## 프라이버시 경계

- **누가 누구를 보나 = 로스터 경계**(ADR-0110·0128). 채널을 공유하는 동료의 프레즌스만 보이고, 그 밖은 아무것도 안 보인다. guest는 자신과 채널을 공유하는 멤버만.
- **DND→푸시 억제**가 프레즌스가 서버 정책으로 넘어가는 유일한 자리다(ADR-0120 소비처, P9의 단일 판정). 누수가 아니라 의도된 소비다.
- **read receipt(타인에게 읽음 노출)는 계속 non-goal**(ADR-0109). 프레즌스 ≠ “네 메시지를 읽음”.
- **`last_seen`(“3시간 전 접속”)은 v0 범위 밖.** online/away/dnd/offline 넷만. 마지막 접속 타임스탬프는 더 큰 프라이버시 표면이라 별도 결정으로 미룬다.

## 되돌리기

라우트를 끄고 `EphemeralSignal::Presence` 변형과 set/read 라우트를 지우면 가용성은 잔여물 없이 사라진다(데이터가 없다). 선언 상태 컬럼은 migration으로 되돌린다. **한 방향 문이 아니다.**

## 미결 (구현 배치가 판단해 PR에 적을 것)

1. **가용성 소스**: 서버가 Centrifugo presence를 읽는 seam vs Centrifugo connect/disconnect 프록시 vs 새 `EphemeralSignal::Presence` 발행. **선호**: 연결 edge에서 새 봉인 변형 발행(서버는 유휴 타이머를 들지 않는다).
2. **enum 최종 어휘**: `auto`의 더 나은 이름 여부, v0에 away/dnd로 충분한지(커스텀 상태 텍스트는 v0 밖).
3. **저장 위치**: v0는 `member.presence_status`(워크스페이스별). 전역 cross-workspace identity는 미실현(ADR-0117)이라 워크스페이스 간 프레즌스는 함께 미룬다.
4. **auto-away**: 유휴 타임아웃 값 + v0가 auto-away를 내는지(클라 파생·만료 규율) 아니면 수동만(auto=접속 시 online).
5. **DND↔푸시 티켓**: NotifierWorker가 `presence_status=dnd`를 소비해 억제 — ADR-0120 푸시 랜딩 뒤 순서.
6. **발행 케이던스**: 가용성 debounce/batch(바이블 해법 ③)와 멀티기기 coalescing.
7. **6a와의 접합**: 하단 프로필 패널이 장차 연결 상태(①)와 자기 선언 상태 컨트롤(③)을 함께 담도록, 6a 이동이 ③ 컨트롤의 자리를 남겨 두는지(별도 6a 패킷이 그 seam을 설계).

## 검증 계약 (구현 배치 수용기준 뼈대 — Accepted 후)

1. `PUT presence`가 본인 `member.presence_status`만 바꾸고(actor binding), 에이전트 bearer는 403/`require_human`.
2. 선언 상태 변경 시 outbox `Broadcast`가 그 멤버의 `ch:` 채널들로만 발행되고 로스터 밖으로 새지 않는다.
3. roster `GET`이 보이는 각 멤버의 `presence_status`를 실어, 부팅 클라가 남의 선언 상태를 재계산 없이 안다.
4. 가용성 경로 처리 중 **PG 쿼리 0건** 단언(ephemeral no-DB 단정 상속).
5. 유효 프레즌스가 (dnd 우선 → away → auto면 가용성) 순으로 계산되고, **저장 컬럼이 없다**.
6. RLS/경계: 워크스페이스·채널 밖 프레즌스 접근 불가. guest는 공유 채널 멤버만 본다.
7. 실상태 없으면 점 없음(장식 dot 금지 = AI-tell, `docs/design-system/README.md`·r1 spec).

## 증보 1 (2026-10-28 기안) — 가용성(②) 구현: 전송 파생 seam · 출석부 · 명부 `online` (#4692)

- 기안: Sonnet 5.5 엔진+UXUI 워커(#4692, owner 2026-10-27 3056 실기 「사람은 상태 관련된 칩으로 접속 및 현재 상태 표시 안해?」). Status는 Accepted 그대로다. 이 절은 「미결」 1·6과 D5의 구현 방식을 정하고, 새 Centrifugo 네임스페이스·명부 필드·구독 규칙을 적는다(공개 API·보안 경계라 ADR-0100 참조용이다).
- 상태 [V: 실측]. 선언 상태(③)는 구현돼 있었고, 가용성(②)은 전송 쪽 부품(`EphemeralSignal::Presence`, `presence:` 네임스페이스, `POST …/channels/{ch}/availability`)만 있고 **소비하는 클라이언트도, 명부에 싣는 필드도 없었다**. 그래서 점은 선언 상태만 그렸다(`statusDot.ts` 머리말).

### 결정
1. **가용성의 소스는 「서버가 Centrifugo presence를 읽는 seam」이다(미결 1).** 이슈 #4692의 Goal이 정했고, 「연결 edge 클라 발행」(본문의 선호)을 택하지 않은 이유는 둘이다. 하트비트 방식은 채널마다 grant와 POST가 한 벌씩이라 클라이언트당 40초마다 O(채널) 요청이 나가고, 무엇보다 **서버가 읽을 상태가 없어서 명부·DM 투영에 필드를 실을 수 없다**. 이미 있는 하트비트 라우트와 `Presence` 변형은 소비자가 없는 채로 남는다(지우지 않았다. 후속).
2. **출석부 채널 `online:ws<WS>`.** 대화가 이름에 없는 유일한 레일이다(세그먼트 하나). 클라이언트는 이것을 읽으려고가 아니라 **세어지려고** 구독한다. 새 네임스페이스 `online`은 `presence: true`, `history_size: 0`, 구독 프록시이고 **`join_leave`·`allow_presence_for_*`·`allow_publish_for_*`·`allow_history_for_*`가 없다**: join/leave 푸시는 모든 구독자(손님 포함)에게 로스터 밖 사람의 접속·해제 스트림을 건네고(가드 5), 나머지는 클라이언트가 표를 읽거나 쓰게 한다. `infra/centrifugo.json`·`infra/railway/railway.json`·`scripts/local_alpha_runner.sh`가 같고, 철도 카탈로그 검사(`online_namespace_errors`)가 항목 전체 일치로 모양을 고정한다(변이 증명 포함).
3. **구독 규칙 = 명부 행 조건(D5).** `online:`은 **활성 사람 멤버**(`workspace_membership` 있음, `status = 'active'`, `deleted_at IS NULL`, `kind = 'human'`)만 가입한다. 앞의 셋은 명부(`list_workspace_roster`)의 행 조건 그대로이고 마지막은 D4다. 그래서 출석부에 들어올 수 있는 사람은 명부가 언젠가 실을 수 있는 사람뿐이다. 손님은 가입한다(손님도 같은 채널을 쓰는 사람에게는 명부 행이다). 에이전트·초대·정지·삭제·다른 테넌트는 거절된다(다른 테넌트는 자격 관문에서 죽는다). **연결 토큰에 `subs`로 넣는 방식은 기각했다** [V: Centrifugo 6.9.1]: 없는 네임스페이스가 하나라도 있으면 **연결 전체가 102로 끊기고**(배포 순서가 어긋난 한 번이 전 클라이언트의 실시간 중단이다), `channel_regex`가 서버측 구독에는 걸리지 않으며, 구독 프록시를 거치지 않는다. 클라이언트측 구독은 같은 상황에서 그 구독 하나만 102로 끝나고 연결은 그대로다.
4. **읽기 seam `momo_ephemeral::PresenceReader`.** 질문은 하나(`online_members(workspace_id)`)이고 채널 이름은 안에서 만든다: 호출자가 만든 채널이나 다른 테넌트의 이름을 물을 길이 없다. 돌아오는 것은 **멤버 id 집합**뿐이고 Centrifugo의 client id와 `conn_info`는 이 파일에서 버려진다. **실패는 `Unavailable`이지 빈 집합이 아니다**(`result.presence`가 없는 몸통, 200 안의 오류 봉투, 시간 초과, 크기 상한 2 MiB 초과 모두). 상태·캐시·타이머가 없고(ADR-0149 가드 4), 이 크레이트는 `sqlx`를 가질 수 없다(매니페스트 시험). 시간 초과는 1.5초다.
5. **명부 `online`.** 사람·`active` 행에만 붙고 **에이전트 행에는 키가 없다**(D4). `presence` 응답은 **행의 원천이 아니라 조회 대상**이다: 명부 쿼리가 돌려준 멤버를 집합에서 찾을 뿐이라, 손님 좁힘(쿼리 안)이 그대로 가용성의 범위다. PG 읽기와 **병렬**이고, 인스턴스에 `CENT_API_*`가 없거나 브로커가 답하지 못하면 **어느 행에도 키가 없다**. 클라이언트는 키 없음을 「모름」으로 읽고 점을 그리지 않는다. 유효 점은 여전히 저장하지 않는다(D3): 코어 `humanPresenceDot`이 `f(선언, online)`을 계산한다 — 방해 금지 > 자리 비움 > 접속 중(채운 초록) / 접속 없음(속 빈 고리) / 모름(점 없음).
6. **「실시간」은 명부 재조회 주기다(미결 6).** 보이는 동안 30초(`AVAILABILITY_REFRESH_MS`, 웹은 탭이 보일 때·폰은 앱이 active일 때). 푸시는 위 2의 이유로 쓰지 않았다. 앞으로 푸시가 필요하면 로스터 경계 안에서만 나가는 신호여야 하고(예: 보고 있는 DM의 상대 한 명), 그것은 별도 결정이다.
7. **자기 행은 이 클라이언트 자신의 연결이다**(코어 `withOwnConnection`). 자기 프레즌스 컨트롤이 이미 `effectivePresence(선언, 연결됨)`을 쓰고, 서버의 `online`은 방금 연 앱에는 출석부 구독이 끝나기 전까지 비어 있다. 가드 6이 막는 것은 연결 점(WorkspaceRail)이 **남에게 나가는 신호**가 되는 일이고, 자기 행 점이 자기 연결을 읽는 것은 그것이 아니다.
8. **#2851(선언 방송 소비)은 묶지 않았다.** 같은 30초 재조회가 선언 상태도 같은 주기로 갱신하고, `ch:` 방송은 열려 있는 채널에서만 오므로 동료 전체의 상태를 받으려면 구독 경계 문제가 먼저 풀려야 한다(이 증보 밖).

### 실측 (Centrifugo 6.9.1, 메모리 엔진 — Railway 팀 인스턴스와 compose가 같다)
- 정상 종료는 **19 ms**에 오프라인으로 보이고, 두 기기 중 하나만 끊으면 온라인이 유지된다(집합이 멀티 기기를 합친다).
- 비정상 끊김(클라이언트 프로세스 정지, pong 없음)은 **30초**에 오프라인으로 보인다. 명부 재조회 주기(≤30초)가 더해진다.
- 가입은 구독 프록시를 거쳐 약 200 ms. 클라이언트의 `presence()`·`publish()`는 103, `history()`는 108(`not available`)로 거절되고 join/leave·publication은 한 건도 오지 않는다. 다른 테넌트의 자격은 「realtime credential is no longer active」로 403이다.
- 브로커가 멈추면 명부는 200이고 어느 행에도 `online`이 없으며, 돌아오면 다시 실린다.

### 수용하는 한계
- **구버전 앱은 출석부에 가입하지 못해 오프라인으로 보인다**(업데이트 전까지). 서버를 먼저 배포하면 새 앱만 세어진다.
- 점의 신선도는 재조회 주기(≤30초)와 끊김 감지(정상 종료 즉시, 비정상 30초)의 합이다.
- 한 워크스페이스의 presence 응답은 **연결 수만큼** 커진다. 2 MiB를 넘으면 그 응답은 「모름」으로 열화한다. 연결이 수천을 넘는 인스턴스는 출석부를 나누는 후속이 필요하다. Redis 엔진이면 끊김 감지가 presence TTL에 기댄다.
- `PUT presence`의 방송(#2851)과 가용성은 서로의 지연을 줄이지 않는다.

### 미결 정리
- 1 해소(위 1). 6 해소(위 6: 가용성은 발행이 없으므로 케이던스는 클라이언트의 재조회 주기다). 4(auto-away)는 v0에서 채택하지 않는다(auto = 접속 여부). 2·3·5·7은 이 증보와 무관하다.

