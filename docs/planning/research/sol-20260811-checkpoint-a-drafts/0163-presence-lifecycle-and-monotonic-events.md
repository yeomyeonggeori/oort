# ADR-0163: 프레즌스 수명주기·공유 채널 프라이버시·단조 이벤트

- Status: **Proposed** (2026-08-11 · 성재 승인 전 Accepted 승격·구현 금지)
- 관련: ADR-0100(결정 거버넌스), ADR-0128(멤버십 수명주기), ADR-0149(휘발 신호·no-PG publish), ADR-0160(사용자 프레즌스), ADR-0162(busy/알림 정책 분리, Proposed), ADR-0165(self-leave, Proposed), `docs/planning/research/2026-08-11-server-security-selfhost-review.md` P-H1~P-H5·P-M1~P-M3
- 발단: 라이브 프레즌스는 Accepted ADR-0160의 2계층 모델을 구현했지만, stale JWT의 권한·role별 로스터 노출·version 없는 durable event·무제한 fan-out과 limiter key 증폭이 서로 다른 seam에 남았다. 개별 `if` 보수로는 같은 actor/channel 정의가 다시 갈라진다.

## Context / options

ADR-0160의 큰 결정은 유지할 가치가 있다: 선언 상태의 봉인 enum은 PG 내구, availability는 짧은 grant를 쓰는 휘발 신호, 유효값은 클라이언트 계산, 사람 전용이다. 현재 enum 라벨은 `auto|away|dnd`지만 공개 수동 상태를 `dnd`로 둘지 `busy` 등으로 바꿀지는 ADR-0162의 최종 어휘를 따른다. 본 ADR은 그 라벨이나 알림 효과를 결정하지 않고 **권한 수명주기와 순서 계약**만 고정한다.

- **A — finding별 국소 패치:** 빠르지만 presence GET/PUT, grant, subscribe, roster가 다시 서로 다른 “active/member/shared” 정의를 갖게 되어 기각한다.
- **B — durable event 제거 후 roster polling:** 역전은 피하지만 ambient traffic과 stale UI를 키우고 ADR-0160의 실시간 표면을 후퇴시켜 기각한다.
- **C — 공용 lifecycle predicate + member별 revision + bounded issuance/fan-out (채택):** 권한을 먼저 확정한 뒤에만 제한된 grant/write가 생기고, 모든 durable 소비자가 같은 단조 원장을 따른다.

## Decision (Proposed)

### D1. 권한의 단위는 `active human`이며, 채널 행위는 그 위에 live membership을 합성한다

서버는 아래 두 predicate를 한 권위 함수군으로 둔다. 이름은 구현에서 달라도 의미를 복제하지 않는다.

1. `active_human_workspace_actor(ws, member)` = 같은 `(workspace_id, member_id)`의 `member.kind='human' AND status='active' AND deleted_at IS NULL` **그리고** `workspace_membership.authority_episode_id`가 같은 workspace/member의 영속 `workspace_authority_episode(state='active')`를 가리키며 그 row가 current authority pointer인 상태.
2. `active_human_channel_actor(ws, ch, member)` = 1 + 같은 workspace의 `channel.archived_at IS NULL` + 정확한 `(ws,ch,member)` `membership.left_at IS NULL` + 그 channel row의 `authority_episode_id`가 1의 current active episode와 일치하는 상태.

presence GET/PUT은 1, ephemeral grant 발급은 2를 tenant transaction 안에서 검사한다. 오래 살아 있는 JWT 자체는 이 판정을 대신하지 않는다. suspended/deleted/workspace-removed bearer는 403이고 status UPDATE·outbox·grant가 0건이어야 한다. `presence:` subscribe도 active credential + live channel membership을 모두 요구한다. 공용 `ch:` subscribe가 agent를 허용해야 하는 곳은 같은 active-member predicate의 kind-neutral 변형을 쓰되, **presence 발행 actor와 grant는 계속 human-only**다.

ADR-0165/S-6a의 nullable expand 전후 혼합 창에는 generation-1 compatibility predicate가 기존 `workspace_membership` 존재+`left_at IS NULL` 검사만 임시 수행할 수 있다. 그러나 그 창에는 same-ID rejoin/reinstate·async close·episode personal output을 계속 off로 두고, machine-readable channel-authorization reader inventory를 generation-2 predicate로 전면 이관해 old reader process/lease 0과 DB contract mode를 확인하기 전에는 위 두 predicate의 권위 계약을 활성화하지 않는다. generation-2 뒤 legacy predicate로 fallback하거나 두 결과를 OR하지 않는다.

Availability heartbeat는 ADR-0149/0160의 no-PG 경로를 유지한다. 대신 grant는 `{member,workspace,channel,issuer_token_id,authority_episode_id}`에 결속하고 publish의 authenticated principal이 같은 non-null token ID와 current authority episode를 모두 가질 때만 쓸 수 있다. TTL은 60초 이하, clock leeway는 5초 이하로 고정한다. 따라서 정지·채널 이탈 직전에 발급된 grant의 잔존 권한은 최대 **65초**이며, workspace leave 뒤 새 token으로 재가입하거나 같은 membership row가 reinstate되어도 옛 grant를 쓸 수 없다. 그 뒤 새 grant는 D1에서 거부된다. 이 bound를 늘리거나 token 없는 bearer에 grant를 주는 변경은 새 결정이다.

기존 Centrifugo 구독은 subscribe proxy가 전달마다 다시 검사하지 않는다. connection JWT는 발급 당시 별도 `workspace_membership.authority_episode_id`를 싣고, Centrifugo `sub`와 모든 user-limited personal rail suffix는 `<member_id>:<authority_episode_id>`처럼 **episode-scoped subject**를 사용한다. `info.member_id`, `info.authority_episode_id`와 membership row ID는 표시·감사 및 current-row 검사용 signed claim으로 별도 유지한다. subscribe proxy는 `request.user`를 UUID 하나로 가정하지 않는다. shared rollout mode가 legacy/dual일 때만 legacy UUID subject를 허용하고, episode subject는 엄격히 파싱해 signed member+episode로 계산한 exact subject 및 DB의 current active episode와 모두 일치해야 승인한다. episode-only에서는 legacy subject를 거부한다. 이 parser/인가를 `ch:`, `dm:`, `typing:`, `presence:`, `agent:`, `agentwork:`와 모든 personal namespace에 공통 적용한다. lifecycle mutation은 app token을 즉시 revoke하고 같은 transaction에 그 옛 subject를 정확히 지정한 `RealtimeDisconnect` effect를 durable outbox로 넣는다. relay는 `disconnect(user=old_episode_subject)`를 멱등 retry한다. 새 episode의 personal event는 새 subject에만 publish하므로 leave 직전 connection이 빠른 재가입이나 같은-row reinstate 뒤의 read-state·notification·presence metadata를 받지 않는다.

connection token TTL도 60초 이하·leeway 5초 이하이고 refresh/reconnect는 D1과 current authority episode를 다시 통과해야 하므로, disconnect API 장애 때도 옛 channel subscription의 상한은 **65초**다. 배포는 TTL을 먼저 낮추고 기존 최대 1800초 token을 drain한다. “전달 시점 재검사”나 0초 차단은 약속하지 않는다.

personal rail은 서버 문자열을 클라이언트가 추측하게 하지 않는다. `POST /v1/auth/realtime-token` 응답에 additive `authorityEpisodeId`, 실제 JWT `sub`와 같은 opaque `personalRailSubject`, 정확한 `readStateChannel`을 싣고 향후 notification/presence personal channel도 서버가 exact name으로 제공한다. 클라이언트는 이 값을 그대로 구독하며 `<member>:<episode>`를 조립하지 않는다. generation-2 서버는 처음에는 이 필드를 **legacy member subject/channel 값으로** 내고 publish도 legacy-only로 유지한다. web, mobile과 라이브 서빙 산출물인 web-legacy(따라서 Tauri desktop 포함)가 “server-provided exact channel 우선, 필드 부재 시 legacy member channel fallback”을 배포한 뒤 old client와 old server binary/lease 0을 확인한다. 그 다음 별도 activation에서 publish를 legacy+episode dual로 열고 connection subject/response를 episode로 flip한다. 기존 최대-TTL legacy connection이 drain될 때까지 dual-publish하고, 누락·중복과 client adoption을 확인한 뒤 episode-only로 닫는다. same-ID rejoin/reinstate gate는 이 마지막 drain까지 계속 fail-closed다.

episode-only 뒤 reactivation을 연 상태에서는 역사상 사용한 `user:*#<member_id>` member-only rail로 즉시 rollback할 수 없다. 그 namespace는 read-state recovery history를 최대 168시간 보유하므로 connection drain만으로는 과거 episode의 private/DM metadata replay를 막지 못한다. 먼저 rejoin/reinstate gate를 다시 닫고 신규 authority activation을 멈춘 뒤 legacy+episode dual-publish를 연다. rollback target은 이미 C-0a client가 그대로 소비할 수 있는 **새 server-issued opaque `legacyRailGeneration` exact channel/subject**여야 하고, 과거 member-only channel을 재사용하거나 client가 suffix를 조립해서는 안 된다. 새 generation에 history가 0인 것을 확인한 뒤 token/exact-channel을 flip하고 old episode·old legacy connection을 각각 disconnect/drain한 다음에만 generated-legacy-only로 내릴 수 있다. control-plane이 exact subject history purge를 증명할 수 있는 경우만 동일 이름 재사용을 허용한다. 다시 reactivation gate를 열려면 반대 방향의 client/fleet drain을 거쳐 episode-only를 먼저 복구한다. 어느 방향이든 old binary를 되살리거나 gate-open 상태에서 historical member-only rail을 단독으로 쓰지 않는다.

### D2. 프레즌스 가시성은 role이 아니라 self-or-active-shared-channel이다

roster 행 자체의 관리 가시성과 프레즌스 가시성을 분리한다. `presenceStatus`와 아래 `presenceRevision`은 target이 self이거나 viewer와 target이 같은 workspace의 **비archive 채널 하나 이상에 둘 다 live member**일 때만 함께 projection한다. owner/admin/member도 이 조건을 우회하지 않는다. 조건이 거짓이면 두 필드 모두 wire에서 생략한다(null로 존재를 암시하지 않는다). guest의 기존 row 필터는 이보다 넓어질 수 없다.

target은 항상 human이지만 viewer는 active human뿐 아니라 같은 live 채널의 active agent일 수 있다. 이는 agent=first-class-member이고 이미 그 채널 message를 읽는다는 기존 경계를 따른 명시적 선택이다. agent는 사람의 public presence를 볼 수 있을 뿐 presence를 설정하거나 private `pauseAll`을 볼 수 없다. agent가 읽지 못해야 하는 제품 요구가 생기면 공용 `ch:`/`presence:` rail로는 충족할 수 없으므로 별도 human-only delivery ADR이 필요하다.

Durable fan-out도 actor가 현재 속한 비archive 채널에만 낸다. 새 subscribe/refresh는 live membership을 검사하고, 이미 열린 구독은 D1의 disconnect+65초 expiry fence로 닫는다. 즉 REST bootstrap과 realtime이 같은 co-member 집합을 지향하되 broker가 전달마다 SQL을 읽는다고 주장하지 않는다.

### D3. 실제 상태·가시성 전이에만 member별 revision을 하나 발급한다

신규 numbered migration으로 `member.presence_revision bigint NOT NULL DEFAULT 0 CHECK (presence_revision >= 0)`을 추가한다(`schema_v0.sql`은 수정하지 않는다). 기존 상태는 revision 0에서 시작한다.

PUT은 인증·member limiter 뒤 workspace authority **shared** key를 잡고 먼저 status를 읽는다. 요청값이 같아 보이면 member row를 잠가 다시 비교하고 여전히 같을 때 channel-set/channel lock 없이 200 no-op으로 끝낸다. 값이 바뀌었으면 member row lock을 쥔 채 다음 lock으로 진행하지 않고 transaction을 내부 재시작해 ADR-0165의 전역 순서인 workspace authority shared → workspace channel-set shared → `LIMIT 501` live non-archived channel UUID 오름차순 shared lock을 잡은 뒤 member와 channel 집합을 다시 읽는다. 이 두 번째 판정에서 값이 이미 같아졌으면 역시 200 no-op이고, 여전히 transition이면 500/501 판정을 적용한다. channel join/leave/archive는 authority shared → channel-set **exclusive** → target channel exclusive 순서라 이 재조회 뒤 PUT commit까지 집합이 바뀌지 않는다. workspace leave/suspend/remove와 bounded join/reinstate finalization은 authority exclusive → channel-set exclusive에서 episode/view generation과 고정 cursor head만 commit하고 child channel/viewer lock을 잡지 않는다. cursor page가 이후 channel-set을 고정하고 UUID 순 최대 500 child lock을 잡는다. 따라서 lifecycle이 먼저 commit하면 pre-lifecycle snapshot으로 더 큰 status frame을 쓸 수 없고, PUT이 먼저면 그 뒤 lifecycle generation/cursor가 무효화한다. member row를 쥔 채 channel-set을 후획득하거나 reverse lock을 얻는 것은 금지한다.

- 요청값이 현재값과 같으면 200 `{status, revision}`을 돌려주되 **UPDATE(`updated_at` 포함) 0, revision 증가 0, outbox 0**인 idempotent no-op이다.
- 값이 실제로 바뀔 때만 `presence_status`와 `presence_revision + 1`을 한 UPDATE로 커밋하고, 그 한 revision을 모든 channel fan-out에 복제한다. 동시 PUT은 row lock으로 직렬화한다.
- v0 durable fan-out 상한은 한 actor당 live non-archived channel **500개**다. 이는 새 멤버십 제한이 아니라 실제 상태 transition 한 번에 대한 **명시적 제품 hard cap**이다. 기존 `CHANNEL_LIST_LIMIT_MAX=500`과 숫자를 맞춘 것은 운영 단순화일 뿐 read pagination이 write 비용을 증명한다는 뜻이 아니다. changed path가 `LIMIT 501`로 mutation 전에 판정해 초과하면 409로 transaction 전체를 거부한다. same-value fast path는 이 fan-out cap과 무관하게 200 no-op이다. 부분 fan-out이나 status-only commit은 금지한다. 구현 전 PG18에서 0/1/100/500 fan-out transaction 시간·WAL·outbox 크기를 측정해 evidence로 제출하고, 수용 불가능하면 숫자를 조용히 바꾸지 않고 이 결정을 revise한다.

대안인 단일 per-member rail은 모든 co-member가 사람별 채널을 추가 구독·grant해야 해 구독 수와 프라이버시 경계를 다른 N×M 문제로 옮긴다. 비동기 fan-out job은 status commit과 알림 사이의 부분 완료를 허용하므로 별도 cursor/reconcile 원장이 필요하다. 둘 다 본 보수보다 큰 아키텍처 변경이라 채택하지 않는다. 실제로 500 초과가 제품 요구가 되면 상수만 올리지 않고 이 두 대안을 별도 ADR에서 다시 비교한다.

Durable wire는 `type:"presence", v:2` payload에 `workspace_id`, `member_id`, `presence_status`, **`revision`**을 필수로 싣는다. idempotency key는 `presence:<workspace>:<member>:<revision>:<channel>`이다. 이 revision은 member 원장이지 channel/message 순서가 아니므로 Centrifugo publish envelope의 `version`에는 넣지 않는다(`version=None`; 서로 다른 멤버의 revision이 같은 채널에서 충돌할 수 있다).

클라이언트는 `(workspace_id, member_id)`별 최고 revision을 보관하고 `revision <= seen`인 retry/역전 frame을 버린다. roster와 own GET/PUT도 `presenceRevision`/`revision`을 실어 bootstrap 기준선을 준다. 전환 중 revision 없는 v1 frame은 상태 setter로 쓰지 않고 필요하면 roster refetch hint로만 취급한다.

leave/suspend/remove, bounded join/rejoin/reinstate와 channel membership join/left/archive처럼 **누가 이 상태를 볼 수 있는지** 바꾸는 mutation은 target/view generation을 먼저 올린다. departing viewer 자신의 rail에는 opaque `momo.presence.view_invalidated.v1 {workspace_id, view_revision}`를 보내며 target ID·channel 목록은 싣지 않는다. 이전 또는 현재 authorized viewer에게만 user-targeted `momo.presence.target_invalidated.v2 {workspace_id, target_member_id, through_revision}`를 보내고 disjoint guest/nonmember에게 target ID가 실린 event는 0이다. 다만 workspace full-lifecycle/reactivation과 channel-scoped mutation의 commit budget은 아래처럼 분리한다.

클라이언트는 target invalidation의 `through_revision`을 status high-watermark로 저장하고 그 이하 status frame을 버린 채 해당 target을 숨긴다. opaque view invalidation은 더 큰 `view_revision`일 때 workspace presence cache를 전부 지우고 roster를 refetch한다. roster envelope는 viewer 자신의 `presenceViewRevision`을 싣고, visible target에만 기존 presence fields/revision을 싣는다. membership mutation은 관련 target/member row를 UUID 순서로 잠가 deadlock을 피한다.

workspace leave/suspend/remove와 bounded join/rejoin/reinstate finalization은 cardinality와 무관하게 target/view revision, schema-constant `presence_revocation_pending` cursor head와 departing viewer opaque full-purge 최대 한 건만 authority transaction에 commit한다. target invalidation은 viewer가 1명이어도 inline하지 않고 NOBYPASS worker가 최대 500/page로 처리한다. 반면 개별 channel join/leave/archive는 workspace authority 종료 transaction이 아니므로 pre/post viewer가 500명 이하인 **그 한 channel**에서만 target invalidation을 inline할 수 있고, 501명 이상이면 같은 cursor 계약을 쓴다. pending 영향을 받는 viewer의 server roster/bootstrap은 presence field를 생략하고, 클라이언트 visibility lease는 마지막 확인부터 65초 이하라 worker가 멈춰도 과거 가시성을 계속 표시하지 않는다. lifecycle/channel mutation을 대형 집합이라는 이유로 거부하거나 한 transaction에서 무제한 fan-out하지 않는다.

channel archive처럼 집합 전체를 바꾸는 연산도 같은 pending-generation/cursor를 쓰고, 기존 channel rail에는 target ID 없는 workspace full-purge hint를 한 건 낸다. 대형 target/view revision 계산은 같은 privacy 규칙의 bounded durable cursor로 수행하고 부분 완료를 관측 가능하게 하며, 무제한 N² transaction으로 구현하지 않는다. cursor가 pending인 viewer의 roster/bootstrap은 presence field를 전부 생략해 fail-closed한다. 클라이언트가 렌더할 수 있는 presence cache visibility lease는 마지막 roster/revision 확인부터 **65초 이하**이고, archive hint·reconnect·lease 만료 중 하나가 오면 즉시 숨기고 refetch한다. 따라서 cursor worker가 멈춰도 과거 co-member presence를 65초 넘게 표시하지 않으며, server는 cursor 완료 전 가시성을 다시 넓히지 않는다. 재가입/재공유는 더 큰 target/view revision을 발급하므로 지연된 invalidation이 새 projection을 지울 수 없다.

cursor 실행체는 BYPASSRLS를 새로 얻지 않는다. 전용 NOBYPASSRLS role이 `search_path=''`, 고정 cursor/workspace ID projection, 최대 500개 batch와 `SKIP LOCKED`만 허용하는 좁은 `SECURITY DEFINER claim_presence_invalidation_batch`를 호출한다. 반환된 workspace마다 `SET LOCAL app.workspace_id` tenant transaction에서 viewer 재인가·outbox write·cursor settle을 수행하며 신규 queue/cursor table은 RLS FORCE와 정본 RLS registry에 들어간다. raw cross-tenant SELECT/UPDATE, 다른 workspace target ID 반환, 범용 claim 함수는 실패해야 한다.

혼합 writer 배포에는 DB fence가 필요하다. `presence_revision` migration은 expand/cutover mode와 trigger를 함께 두어 expand 동안 legacy status UPDATE도 revision을 단조 증가시키지만 server v2 output은 계속 off다. 모든 API writer를 generation 2 binary로 교체·drain한 뒤 durable contract mode를 v2로 flip한다. v2 mode에서는 transaction-local writer generation과 정확한 `OLD.revision + 1` 없이 status를 바꾸는 UPDATE를 trigger가 거부한다. 그 뒤에도 visibility lease·target/view invalidation을 이해하는 최소 지원 web/mobile/web-legacy가 배포되고 old incompatible client usage와 connection/bootstrap lease가 0인 증거가 있어야 `revision_v2` output을 연다. 구 binary rollback은 status write를 fail-closed하므로 지원하지 않고, rollback은 generation 2 binary에서 output flag만 내린다. 이 fence 없이 v2를 켜면 구 writer가 revision을 올리지 않은 최신 상태를 써서 client stale-drop에 먹히거나 구 client가 폐기된 presence를 무기한 표시할 수 있으므로 금지한다.

### D4. 비용을 만드는 순서와 limiter cardinality를 봉인한다

- **Durable PUT:** 인증·body 검증 뒤 신뢰 가능한 `(workspace, principal.member)` key로 기본 **10회/60초/API replica** member limiter를 먼저 건다. same-value 요청도 요청 예산은 소비하지만 DB/outbox는 D3대로 no-op이다. 초과는 표준 오류 envelope의 429 + 정수 `Retry-After`; DB transaction은 열지 않는다.
- **Grant 발급:** `member-wide grant limiter → D1의 DB predicate → 검증된 channel bucket → sign` 순서다. 기본 grant mint 상한은 member당 **10회/60초/API replica**이고, 임의 channel UUID는 DB 판정 전에 bucket key가 될 수 없다.
- **Availability publish:** `member-wide limiter → grant 서명·만료·scope 검증 → member/channel limiter → publish` 순서다. 기본값은 기존 계약인 member **120회/60초/API replica**, member/channel **30회/60초/API replica**다. 잘못된 grant는 신뢰되지 않은 channel bucket을 만들지 않는다.
- limiter는 member당 동시 channel bucket을 grant mint 상한 이내로 제한하고 window 종료 후 제거한다. top-level container도 유한 capacity를 가지며, sweep 뒤에도 자리가 없으면 live bucket을 몰래 evict해 제한을 우회시키지 않고 429로 fail-closed한다. invalid UUID 반복으로 key 수가 늘어날 수 없어야 한다. v0 저장소는 현행 in-process limiter이고 API replica가 N개면 유효 cluster ceiling은 위 수치의 최대 N배다. 배포는 replica count와 per-replica reject metric을 노출한다. strict cluster-global budget이 필요하면 no-PG availability 계약과 shared store를 별도 ADR에서 결정한다. 운영값은 높일 수 있지만 무제한/0은 test 외 conformant 설정이 아니다.

## DB · wire · API 영향

1. DB 변경은 `presence_revision`, `presence_view_revision`, writer contract mode/trigger와 visibility mutation용 `presence_revocation_pending` generation+bounded invalidation cursor다. workspace lifecycle은 revision+고정 cursor head(+departing opaque purge 1건), channel-scoped mutation은 revision+≤500 inline 또는 cursor를 각각 자기 transaction에 commit한다. availability heartbeat는 계속 SQL 0건이다. 공용 `workspace_membership.authority_episode_id`는 ADR-0165가 소유한다.
2. `GET/PUT /v1/workspaces/{ws}/presence`의 200은 `{status, revision:int64}`. PUT은 400(닫힌 enum/body), 401, 403(lifecycle), 409(fan-out cap), 429(`Retry-After`)를 명시한다. body에 `memberId`는 계속 없다.
3. roster envelope는 viewer의 `presenceViewRevision:int64`를 싣고, `RosterMember`는 공유 경계를 통과한 human에만 `presenceStatus`와 `presenceRevision:int64`를 함께 싣는다.
4. 기존 `POST /v1/workspaces/{ws}/channels/{ch}/typing/grant`는 availability도 쓰는 shared ephemeral grant로 유지하고 200/401/403/429/503 및 TTL/scope를 문서화한다. 이름 변경은 별도 versioned API 결정이다.
5. `POST /v1/workspaces/{ws}/channels/{ch}/availability`는 body `{grant}`와 202 `{channel, expiresAtMs, republishAfterMs}`를 정본화하고 400/401/403/429/502/503을 명시한다. 이 네 operation과 모든 request/response/error schema를 `docs/api/openapi.yaml`에 추가해 runtime route와 shape gate가 상호 검증하게 한다.
6. realtime-token response는 additive `authorityEpisodeId`, `personalRailSubject`, `readStateChannel`을 먼저 제공하고, presence personal invalidation을 열기 전 exact `presenceViewChannel`을 추가한다. ADR-0162의 `notificationIntentChannel`도 같은 server-directed exact-name 규칙을 쓴다. OpenAPI/generated client와 runtime shape를 맞추고 web/mobile/web-legacy는 exact channel 우선+legacy fallback을 배포한다. subscribe proxy의 legacy/composite dual parser와 signed member/current-episode 검증을 모든 proxied namespace에 먼저 적용하며, episode subject flip은 old client/server/token drain 뒤 별도 shared rollout mode로만 수행한다.
7. ADR-0162와 동시 이행 시 client dual-read → generation-2 writer 전면 배포·DB v2 fence → server `v2/dnd` → 검증 뒤 server `v2/busy` 순서를 고정한다. `revision_v2`와 `busy_output`은 독립 flag이고 `v1/busy`는 발행하지 않는다.

## Consequences

- (+) 정지된 bearer, role 우회, outbox retry 역전이 한 predicate/revision 계약으로 닫힌다.
- (+) same-value spam과 channel 수가 실제 PG write/publish 증폭으로 곱해지지 않고, invalid UUID가 limiter memory를 키우지 않는다.
- (-) status wire v2와 모든 소비자의 revision cache가 함께 배포되어야 하며, 롤링 배포 중 v1을 권위값으로 취급할 수 없다.
- (-) 500채널을 넘는 actor는 상태를 바꾸기 전에 멤버십을 줄여야 한다. 이 한계가 실제 제품 요구와 충돌하면 부분 fan-out이 아니라 별도 fan-out architecture ADR로 재설계한다.

## Verification contract (Accepted 후)

1. active/suspended/deleted/workspace-removed human의 **실제 bearer** 매트릭스로 GET/PUT/grant/`presence:` subscribe를 검증하고, 거부 시 UPDATE·outbox·grant가 0임을 단언한다. 새 current episode token과 옛 private/DM channel row, active member와 noncurrent/ended episode, fabricated cross-tenant episode binding도 모두 0 row/403이며 generation-2 contract 뒤 legacy predicate fallback이 0임을 검증한다.
2. owner/admin/member/guest 각각에 대해 self, shared-channel human, disjoint human을 만들고 disjoint row에는 두 presence 필드가 없으며 durable frame도 도달하지 않음을 검증한다.
3. 현재 라벨 기준 `away→dnd→away`(ADR-0162가 rename하면 그 최종 두 수동 라벨의 `A→B→A`)와 relay retry 역전을 재현해 revision이 `1→2→3`, 소비 결과가 revision 3인지 확인한다. 동시 PUT도 revision 중복/유실이 없어야 한다. DB v2 fence 뒤 legacy writer SQL은 상태 변경에 실패하고 generation-2 writer만 정확히 +1 한다.
4. 같은 값 PUT은 revision·`updated_at`·outbox가 모두 불변이고 **501채널에서도 200 no-op**이다. 실제 transition은 500채널에서 최대 500 outbox, 501채널에서 409 + mutation/outbox 0이다. `501×same-value`, `501×changed`와 두 concurrent PUT을 각각 fixture로 둔다. channel archive/join/leave와 PUT을 barrier로 경합시켜 channel-set→UUID lock 순서로 직렬화되고, archive/full-purge가 먼저 commit한 뒤 pre-archive status frame이 더 큰 revision으로 다시 생기는 경우가 0인지 검증한다.
5. PUT/grant/availability 각 limiter는 경계값과 429 `Retry-After`를 검증한다. 임의 UUID·invalid/expired grant 반복 뒤 bucket 수가 bound를 넘지 않아야 한다.
6. availability 성공 경로 SQL 0건, grant 발급은 tenant tx의 공용 predicate만 읽음, grant 유효기간+leeway가 65초를 넘지 않음을 검증한다. leave 전 grant+leave 후 새 token 조합과 다른 token ID 조합은 거부된다.
7. OpenAPI 네 operation의 2xx/4xx/429/502/503 sample과 runtime DTO를 `verify_openapi_contract`에서 대조한다.
8. leave/suspend/remove race에서 새 subscribe/grant는 즉시 실패하고 정상 broker는 옛 episode subject의 durable disconnect를 멱등 처리한다. same-ID rejoin은 새 authority episode/token/subject를 쓰고, 같은 membership-row reinstate는 새 episode를 열되 token 0이며 후속 사용자 login만 그 episode의 token/subject를 발급한다. 어느 경우도 옛 connection·grant는 새 user-limited rail을 받지 않는다. disconnect API 장애에서도 기존 channel connection이 65초 안 종료된다. realtime-token exact-channel 필드가 legacy server와 호환되고, web/mobile/web-legacy 지원 배포·old client/server/token drain → dual-publish+episode subject → episode-only 순서에서 read-state 누락·중복 resurrection이 0임을 증명한다. reactivation 뒤 rollback fixture는 168시간 recovery가 남은 과거 member-only channel을 새 episode가 구독하지 않고, history 0인 새 opaque legacy generation 또는 증명된 purge 뒤에만 generated-legacy로 전환되는지 확인한다. legacy UUID/composite/generated-legacy subject 각각에 대해 `ch:/dm:/typing:/presence:/agent:/agentwork:`와 personal rail 전체를 subscribe proxy matrix로 검증하고, signed member/episode 불일치와 episode-only legacy subject는 모두 deny한다.
9. shared-channel agent는 human public presence를 읽되 disjoint agent와 모든 viewer는 `pauseAll`을 보지 못한다. API replica N개 test에서 문서화한 최대 N배 rate ceiling과 per-replica bucket bound를 확인한다.
10. V가 T와의 마지막 shared channel을 떠나면 V는 target ID 없는 더 큰 view revision으로 full-purge하고, T는 V의 더 큰 target revision으로 cached V를 지운다. disjoint guest/nonmember rail에는 V/T ID가 0이다. delayed leave/archive invalidation은 재가입·재공유 뒤 더 큰 target/view revision 상태를 지우지 못한다. workspace lifecycle은 viewer 0/1/500/501/5,000 모두 inline target outbox/child lock 0, cursor head 수 상수이고 page 최대 500인지 확인한다. 개별 channel mutation은 500 이하 inline bound, 501 이상 cursor를 검증한다. cursor를 정지해도 affected client가 hint/lease로 65초 안 cached presence를 숨기고 server bootstrap은 pending 동안 field를 생략한다. cursor crash/retry는 누락·중복 노출 없이 완료된다. 최소 지원 버전 미만 client usage 또는 old visibility lease 미지원 session이 하나라도 남으면 v2 output activation이 거부된다.

## Rollback / 기존 ADR과의 관계

롤백은 먼저 presence PUT·availability/grant를 feature flag로 fail-closed하고 v2 outbox가 drain됐는지 확인한 뒤 generation-2 binary의 v2 output만 내린다. DB writer fence를 낮춰 구 writer를 되살리지 않는다. 클라이언트는 revision 계약을 이해하지 못하면 프레즌스 점을 숨기고 roster를 권위로 재조회한다. `presence_revision`과 writer contract는 additive라 즉시 DROP하지 않고 남긴다. v1의 unbounded write를 다시 여는 구버전으로 자동 회귀하지 않는다. 삭제가 필요하면 별도 forward migration으로 하고 068이나 적용된 migration을 고치지 않는다.

이 ADR이 Accepted될 때 **ADR-0160을 부분 supersede**한다: D1(availability 휘발), D3(유효값 계산), D4(사람 전용), `last_seen` 제외는 유지한다. D2의 “version 없는 projection” 구현 해석, D5/가드 5의 구독·발급 세부, roster/fan-out 검증 계약은 본 ADR의 lifecycle/privacy/revision/bound가 대체한다. ADR-0149의 no-PG publish와 봉인된 ephemeral rail은 대체하지 않고, grant 발급 read와 limiter 순서만 강화한다. 공개 presence enum과 카피는 ADR-0162의 최종 결정을 참조한다. 이 ADR은 `dnd` 대 `busy`를 고르지 않으며 어느 라벨도 알림 정책 원장으로 만들지 않는다.
