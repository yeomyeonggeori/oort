# Checkpoint A — ADR 일괄 결정표

> 작성: sol · 2026-08-11 KST · 트랙: **엔진**
> 코드 기준: `origin/main = 915d00bff14f`
> 상태: **검토 요청 — ADR-0162~0166은 모두 Proposed**
> 범위: 방향 결정만 요청. 이 문서 승인만으로 ADR 상태 변경, BUILD_TICKETS/Issue 생성, 구현, commit/push/merge를 허가하지 않는다.

## 1. 결정 요약

| 결정 | Proposed ADR | sol 권고 | 성재 판정 |
|---|---|---|---|
| D-1 공개 상태와 알림 일시정지 | ADR-0162 D1 | 공개 `dnd`를 `busy`/“바쁨”으로 migration하고, 비공개 알림 정책은 `pauseAll`로 분리한다. 두 값을 추론·복사·OR하지 않는다. | **Pending** (`accept / revise / reject`) |
| D-2 전 기기 알림 판정 권위 | ADR-0162 D2 | NOBYPASS notifier가 recipient를 최대 500/page로 cursor 처리해 member별 최초 verdict+user intent를 immutable하게 쓰고 desktop/web/mobile은 5분 id-only intent를 소비한다. candidate 전체의 단일 시점 snapshot은 약속하지 않는다. | **Pending** (`accept / revise / reject`) |
| D-3 presence lifecycle·privacy·순서 | ADR-0163 | active-human/live-channel predicate, 별도 authority episode에 묶인 token/grant, server-directed personal channel, shared-channel agent viewer, status/visibility revision+bounded cursor+65초 cache lease, legacy writer fence, per-replica limiter, 500 status cap과 revoke fence를 채택한다. | **Pending** (`accept / revise / reject`) |
| D-4 workspace avatar 무결성 | ADR-0164 | authority-episode pre-intent+최종 strict owner/admin 재인가, SHA-256, 5MiB·4096px/16M pixel, durable NOBYPASS GC와 tenant FK를 채택한다. nullable/dormant fence expand→gen2 drain→DB writer fence·legacy-write red→backfill→digest cutover로 이행한다. | **Pending** (`accept / revise / reject`) |
| D-5 self-leave 이력·join/reinstate | ADR-0165 | workspace authority는 영속 episode ledger+current pointer로 격리하고 종료 transaction은 child 수와 무관하게 episode와 고정 cursor head만 닫는다. channel history·capability cleanup은 최대 500/page다. 신규/same-ID human join과 human reinstate는 preparing episode+202/token 0 cursor 뒤 final generation을 다시 bump한 stable 200에서만 authority를 연다. join만 token을 반환하고 reinstate token은 후속 login만 발급한다. agent reinstate는 별도 pairing/reissue 전 409다. | **Pending** (`accept / revise / reject`) |
| D-6 webhook root 분리·회전 | ADR-0166 | 32-byte 이상 방향별 keyring과 row별 `kdf_key_id`를 도입하고, outbound는 prepare→test→old-generation delivery drain→activate로 개별 회전한다. | **Pending** (`accept / revise / reject`) |

## 2. 반드시 명시적으로 고를 trade-off

### ADR-0162 — 어휘 migration과 서버 delivery intent

- `busy` migration은 공개 상태가 실제로 하지 않는 “알림 차단”을 약속하지 않게 하지만, web/desktop/mobile의 dual-read와 enum expand→cutover→contract가 필요하다. 물리 `notification_rule.dnd`는 롤링 호환을 위해 v0에서 유지한다. 엔진 additive 변경은 새 intent writer와 `busy`/revision-v2 output을 기본 off로 landing하고, 지원 client 배포 증거 뒤 별도 activation goal에서만 켠다.
- 서버 intent는 APNs와 desktop policy를 하나로 만들지만 PG decision/outbox/user rail이 생긴다. candidate는 stable recipient cursor로 최대 500명씩 처리하고 member별 최초 durable verdict를 immutable하게 저장해 crash retry 재판정과 대형 채널 단일 transaction을 함께 막는다. notifier는 push뿐 아니라 T3/fallback/lease/approval 모든 cross-tenant loop를 bounded claim+NOBYPASS tenant settle로 옮기고 BYPASS role을 제거한다. payload는 ID+reason만, TTL 5분이며 read-state `user` namespace와 분리한 전용 history-0 notification namespace를 쓴다. lifecycle disconnect가 실패해도 TTL clamp+legacy drain 뒤 connection token으로 최대 65초에 닫힌다.
- ADR-0120 미결 부록은 선택지 1로 해소해 `work_session_idle`을 5번째 정식 reason으로 유지한다. PushRelay+정직한 mock/gate를 먼저 넓히고 RN validator가 뒤따르며, 거짓 `resume_offer`나 400 영구폐기는 허용하지 않는다.
- 구서버는 `pauseAll`을 400으로 거부하므로 capability 부재 시 신클라이언트도 write는 `{dnd}` 하나만 보낸다. old server drain 뒤 별도 write cutover를 연다.
- full-replacement PUT에는 revision ETag를 붙인다. cutover 뒤 `If-Match` 누락/불일치는 428/412로 막아 두 기기의 stale write가 다른 설정을 되돌리지 않으며, private deny reason은 terminal 또는 24시간 뒤 scrub한다.
- message candidate는 workspace와 channel membership-mutation shared lock 아래 `authority_generation`과 `channel.membership_generation`을 snapshot한다. rejoin/reinstate와 channel join/rejoin/leave는 대응 exclusive lock에서 generation을 올린다. judgment가 늦어져도 candidate 뒤 생긴 authority episode/channel access는 과거 알림을 받지 않고, judgment 뒤 channel leave/rejoin도 pending transport를 claim하지 못한다. pre-migration source-null candidate는 drain 또는 fail-closed expire한다.
- APNs dispatch는 token ID뿐 아니라 등록 당시 영속 authority episode와 단조 registration generation을 snapshot하고 claim 때 recipient current episode와 row를 함께 재확인한다. nullable episode/generation backfill 뒤 register·rotate·revoke·lifecycle invalidation writer를 모두 gen2로 바꾸고 old process/lease 0→DB transition fence red를 확인한 뒤에만 output을 연다. leave→rejoin 뒤 cleanup이 멈춰도 old-episode token은 새 candidate target이 아니며 current episode로 명시 재등록+generation 증가한 token만 성공한다. revoke보다 먼저 선형화된 id-only APNs 한 건은 provider에서 retract할 수 없고 이후 message fetch는 403이다.
- 클라이언트에는 `legacy|intent|disabled` delivery mode를 서버가 준다. raw fallback은 legacy에서만, intent 부재는 intent mode에서 authoritative deny다. intent activation은 old incompatible client 0 뒤 output-off `legacy→disabled` drain→`intent` adoption/ACK drain→writer output on 순서라 raw+intent 중복과 disabled-client 누락을 함께 막는다.
- activation은 세 축을 묶지 않는다: 새 intent writer는 old notifier/channel/push-registration writer generation·lease와 legacy-mode client 0, `pauseAll` write는 old API/client 0+ETag 지원 client, `busy` output은 **revision-v2 output/adoption + dnd|busy 지원 client/old incompatible 0**을 각각 증명한 뒤에만 켠다. 세 축은 별도 goal/승인이다.
- 권고 판정: **D-1 accept, D-2 accept**.

### ADR-0163 — 500채널 write-amplification budget

- 500은 새 membership 제한이 아니라 changed-status PUT의 명시적 product/write cap이다. 기존 list ceiling과 숫자가 같다는 사실은 성능 증거가 아니므로 PG18 0/1/100/500 benchmark를 구현 전 증거로 요구한다. 501채널이라도 same-value면 channel lock 없이 200+write 0, 실제 transition이면 상태/outbox 0인 409다.
- rate 숫자는 현행 in-process 구현에 맞춘 **API replica별** 상한이라 N replica의 cluster ceiling은 최대 N배다. public presence subject는 human-only지만 같은 shared channel의 active agent viewer는 볼 수 있다. grant는 발급 token ID+별도 authority episode에 묶는다. personal channel은 server-provided exact name을 web/mobile/web-legacy가 먼저 소비하고, subscribe proxy가 legacy UUID/composite subject를 signed current episode와 대조하도록 모든 proxied namespace를 고친 뒤 old client/server drain→legacy+episode dual→episode-only로 cutover한다. visibility 변화는 이전/현재 authorized viewer에게만 target invalidation을 보내고 departing viewer 본인에는 target ID 없는 full-purge epoch를 보낸다. 501명 이상 leave/archive는 NOBYPASS bounded cursor로 처리하며 worker가 멈춰도 server bootstrap fail-closed+65초 client visibility lease로 과거 상태를 계속 표시하지 않는다. v2 전환 뒤 legacy writer는 DB fence에서 fail-closed하고 old lease/invalidation 미지원 client usage 0 뒤에만 output을 연다. 기존 channel realtime read의 탈퇴 후 잔존은 durable old-episode disconnect+60초 token(+5초 leeway)로 닫는다.
- 500 초과 **presence status PUT**이 실제 요구라면 상수만 올리지 않고 per-member rail 또는 async status fan-out architecture를 새 ADR에서 결정한다. lifecycle invalidation은 거부하지 않고 bounded cursor로 진행한다.
- revision v2는 generation-2 API writer 전면 배포→old writer/lease 0→DB writer fence v2 flip→legacy write red proof→v2 output 순서다. rollback은 fence를 낮추지 않고 generation-2 binary의 output만 내린다.
- reactivation을 연 뒤 personal rail을 rollback해야 하면 rejoin/reinstate gate 재폐쇄가 먼저다. 과거 member-only channel은 168시간 recovery history가 있어 재사용하지 않고, dual-publish→history 0인 새 server-issued opaque legacy generation→양쪽 connection drain→generated-legacy-only 순서로만 내린다. episode-only를 다시 복구하기 전에는 gate를 재개방하지 않는다.
- 권고 판정: **accept**. 단, 500개 초과 채널에 속한 사용자의 상태 변경도 허용해야 한다면 이 항목만 `revise`.

### ADR-0164 — strict setter와 이미지 처리 비용

- `platform:read` override를 avatar setter에서 제외하고 active human owner/admin만 허용한다. Drive 전 cleanup intent를 live membership ID·immutable authority-episode·avatar-operator loss-generation snapshot에 결속한다. generation은 owner/admin capability 상실 때만 증가하므로 demotion 뒤 재상승은 과거 upload를 complete하지 못하지만 owner↔admin처럼 capability를 계속 보유하는 변경은 진행 중 upload를 닫지 않는다.
- content read는 응답 전에 최대 `5MiB + 1`을 buffer·검증하고 single-frame, 4096px/16M pixel로 decode를 제한한다. CDN 직결보다 비싸지만 `immutable`과 같은 URL/같은 bytes를 실제 보장한다.
- GC는 raw BYPASS role이 아니라 제한 `SECURITY DEFINER` claim만 쓰는 전용 NOBYPASS worker다. 이 실행 topology까지 D-4 승인 범위다.
- 기존 complete와 롤링 binary가 있으므로 digest 컬럼과 dormant writer fence·bounded/resumable backfill 도구를 먼저 배포한다. generation-2 writer/dual-reader는 legacy UUID를 no-store로만 서비스하고, old writer/reader·lease 0 뒤 **DB fence를 먼저 flip해 legacy NULL-digest write를 red로 만든 다음** current Drive object를 검증 backfill한다. historical noncurrent complete는 `superseded`+GC로 정규화한 뒤 digest output을 별도 승인으로 열고, soak와 모든 complete NULL 0 뒤 별도 contract goal에서만 NOT NULL/status constraint를 validate한다.
- 권고 판정: **accept**.

### ADR-0165 — “이력”의 책임 분리

- channel 참여 종료 증거는 `membership.left_at`, workspace 현재 권한은 `workspace_membership`, role·joined/left/rejoin 서사는 append-only audit가 소유한다. 별도 RLS FORCE `workspace_authority_episode`는 current membership을 삭제해도 남는 보안 ledger이며 token/grant/avatar/notification child FK를 cascade하지 않는다.
- v0는 channel membership을 append-only episode 테이블로 바꾸지 않는다. authority 종료 transaction은 episode/current pointer와 schema-constant cleanup cursor head만 즉시 닫고, `left_at`, token/push, WorkHost, agent owner, grant, avatar/notification/run materialization은 subsystem별 최대 500/page다. 모든 claim reader가 old episode를 즉시 거부하므로 cursor 정지는 권한 종료를 늦추지 않는다. 신규/same-ID human `/join`은 live public channel을 현재 invite의 safe channel role로, human suspend→reinstate는 suspend 직전 live public/private/DM+role을 preparing episode에 500/page로 결속하고 그동안 202/token 0이다. stable final retry가 authority generation을 다시 bump한 뒤 new/rejoin만 token을 반환하며 reinstate는 target token 0+후속 사용자 login이다. final deny·expiry는 episode를 끝내고 abort cursor가 기존 `left_at`/role/episode/access를 복원하며 never-active channel row만 제거한다. provisional member는 ended episode FK target으로 deleted/never-active tombstone 보존한다. agent suspend/remove run은 claim 즉시 차단+bounded cleanup이고 agent reinstate는 별도 pairing/reissue 전 409다. 기존 channel 구독의 65초 보장은 TTL clamp+legacy drain 뒤에만 성립한다.
- ledger rollout은 nullable expand/compatibility trigger→existing membership/token/channel binding backfill→workspace create·human join·agent provisioning·login/refresh/token/channel writer와 모든 channel-auth reader gen2 drain→old writer/reader 0→DB NULL-write red→NULL 0/FK contract 순서다. old private/DM row는 새 episode token으로 어느 reader에서도 열리지 않아야 하며 same-ID reactivation/async-close gate와 output은 이 창 내내 off다.
- 중요한 rollout trade-off: 현재 live `/join` deleted reactivation을 먼저 닫되 신규 identity join은 호환 창에서 동기로 유지한다. bounded schema와 신규/same-ID 202 client가 배포된 뒤 old join writer/client 0에서 모든 human join을 cursor mode로 전환한다. Rust에 없는 admin reinstate는 dormant route/spec landing→별도 admin UXUI 배포·old client 0→human-only activation 순서이고 그 전에는 503 fail-closed다. member ID를 바꾸거나 일부 capability 부활을 허용하는 우회는 하지 않는다.
- 권고 판정: **accept**.

### ADR-0166 — 기존 outbound row provenance

- 기존 outbound secret은 발급 당시 전용 root와 JWT fallback 중 어느 쪽이었는지 현재 env나 설치 전역 mode만으로 증명할 수 없다. nullable expand 뒤 key-aware binary를 legacy active-write로 배포하고 구 writer/sender를 DB fence+drain한 다음 subscription별 provenance manifest로 분류한다. 증명 못 한 행은 prepare→test→old credential-generation delivery drain→activate로 개별 재발급하며, old generation 0과 KDF-target NULL 0 전에는 dedicated write를 열지 않는다.
- 현 webhook sender의 BYPASSRLS 요구도 하드 불변식 위반이므로 같은 rollout에서 NOBYPASS role+bounded `SECURITY DEFINER` claim+workspace별 tenant settle로 이설하고 old BYPASS process/lease·role grant 0을 증명한다.
- normal delivery는 signature 하나만 유지한다. `prepare`가 새 secret을 reveal하고, `test` 한 건만 새 secret으로 서명한다. activate 전 신규 claim을 멈추고 old credential-generation lease/in-flight HTTP 0을 확인한 뒤 active key를 원자 교체해 commit 후 old-signature 401 유실을 막는다. fresh install은 서로 다른 32-byte 이상 두 root가 없거나 JWT와 재사용되면 기동 실패한다.
- native/outbound legacy row와 rollback window가 모두 0이 된 contract 단계에는 sender뿐 아니라 inbound API의 JWT derivation/resolver·compatibility mode도 제거하고 legacy KDF ID 신규 사용을 fail-closed한다. Slack-compatible NULL은 별도 불변이다.
- 권고 판정: **accept**.

## 3. ADR dependency cluster

D-2~D-5는 구현 순서만 연결된 독립 선택지가 아니라 같은 authority/rail/lifecycle 경계를 서로 참조하는 **호환 cluster**다.

| ADR | Accepted 전 필요한 결속 |
|---|---|
| ADR-0162 D2 | ADR-0163의 episode personal rail·disconnect와 ADR-0165의 authority/channel generation |
| ADR-0163 | ADR-0165의 authority episode·reactivation fence |
| ADR-0164 | ADR-0165의 immutable authority episode와 lifecycle terminalizer |
| ADR-0165 | ADR-0162 notification cancel, ADR-0163 invalidation/rail, ADR-0164 avatar cleanup 소비자가 함께 닫히는 rollout |

따라서 D-2~D-5는 호환 가능한 한 묶음으로 `accept`하거나, `revise`할 때 대체 ADR/경계를 함께 지정한다. ADR-0162/0163/0164/0165 중 하나만 단독 Accepted로 바꾸지 않는다. D-1은 D-2와 같은 ADR-0162에 있으므로 둘 다 accept일 때만 그 문서가 전환 후보이고, D-6은 이 cluster와 독립이다.

## 4. 승인 경계와 다음 묶음

1. 성재가 위 6개 결정을 `accept / revise / reject`로 답한다.
2. sol이 수정 요청을 한 번에 반영하고 ADR 간 용어·dependency를 재검수한다.
3. 성재가 **ADR별 Accepted 전환 목록을 명시적으로 승인**한 뒤에만 해당 상태와 관련 정본을 바꾼다. ADR-0162는 D-1과 D-2가 모두 accept일 때만 전환 후보이고, ADR-0162~0165는 위 cluster 전체 또는 명시된 동등 대안 없이는 부분 전환하지 않는다.
4. BUILD_TICKETS ID·goal별 handoff를 만든 뒤, 별도 승인으로 GitHub Issue를 발급한다.
5. Merge floor G-1~G-5가 적용되기 전에는 S/C 구현을 merge하지 않는다. Wave 2의 UX 검수와 서버·보안 completion gate도 분리하며, 모든 필수 C goal과 승인된 cutover가 끝나기 전 Wave 3을 열지 않는다. 코드 구현은 성재의 별도 착수 지시 전 시작하지 않는다.

## 5. 답변용 최소 양식

```text
D-1: accept | revise: ... | reject: ...
D-2: accept | revise: ... | reject: ...
D-3: accept | revise: ... | reject: ...
D-4: accept | revise: ... | reject: ...
D-5: accept | revise: ... | reject: ...
D-6: accept | revise: ... | reject: ...

D-2~D-5 cluster: accept as set | revise with replacement: ...

ADR Accepted 전환: 아직 보류 | 전환 승인 목록: 0162, 0163, ...
```
