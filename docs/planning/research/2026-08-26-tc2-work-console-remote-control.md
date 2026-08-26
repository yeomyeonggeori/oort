# 리서치 — TC-2 작업 콘솔: 팀 터미널 트래킹 + 원격 조작 (2026-08-26)

- 발제: 성재 (2026-08-25, #1759) — *"좌측 작업 콘솔 = 팀원들이 작업 중인 터미널을 herd/orca처럼 전반 트래킹 + 가능하면 팀원 터미널 원격 조작"*
- 성격: **ADR 선행 기획 리서치**. 구현 티켓 아님. 원격 조작은 보안/권한 경계 — Accepted ADR 없이 착수 금지(CLAUDE.md 하드 룰).
- 기안: Fable · 이 문서는 결정이 아니라 **결정 재료**다. §6이 ADR 기안 입력, §7이 성재 몫.
- 근거 성격: §1·§3은 **레포 실측**(파일:라인). §2는 웹 리서치 + 레포 내 herdr 실측 스파이크(`research/2026-08-06-herdr-spike.md`).

---

## 0. 다섯 줄 결론

1. **트래킹은 이미 서버에 있다.** `GET /work-sessions`가 「내가 멤버인 채널의 모든 사람 세션」을 소유자 무관하게 200행까지 돌려주고, 웹 `WorkConsoleRoute`가 그걸 이미 그린다. TC-2의 트래킹 절반은 신규 계약이 아니라 **표면 작업**이다.
2. **원격 조작은 0이 아니라 "소유자 전용으로 이미 존재"한다.** PTY controller 등급도, 화면(display) controller 등급도 서버·웹에 실존한다. 없는 것은 **남의 세션에 대한 조작권**이며, 그것을 막는 것은 단 한 줄의 술어(`c.owner_member_id = ws.member_id`)다. 즉 TC-2는 새 전송 계층이 아니라 **권한 모델 확장** 문제다.
3. **성재가 지목한 "핵심 긴장"은 실은 이미 해소되어 있다.** 단일 쓰기경로는 `message.seq`를 갖는 **영속 상태**의 경로이고, 터미널 바이트는 ADR-0125 D10에서 애초에 **서버 비경유**로 결정됐다. 키 입력이 PG를 지나간 적은 한 번도 없다. 진짜 질문은 *"키를 어떻게 PG에 태우나"*가 아니라 **"권한·동의·감사를 어디에 영속시키고, 바이트는 어느 평면에 둘 것인가"**다.
4. **그러나 TC-2 이전에 이미 깨져 있는 것이 셋 있다** — ⑴ Rust 서버에 PTY 바인딩을 쓸 주체가 없어 `remote_attach_available`가 **항상 false**(관전 도크가 붙을 PTY가 원리적으로 없음) ⑵ 소유자의 관전 차단 토글이 **400을 뱉는다**(동의 모델이 열린 채 잠김) ⑶ 감사 행은 쓰이지만 **읽을 라우트가 Rust 서버에 없다**. 이 셋을 고치지 않고 조작권을 얹는 것은 잠금장치 없는 문에 손잡이를 다는 일이다.
5. **레퍼런스는 우리를 구해주지 않는다.** 조사한 10종 중 **GNU screen의 `writelock` 하나만** 실제 단일-writer 중재를 가진다. Live Share·Warp·sshx·Zellij·tmate 전부 「읽기전용 토큰 / 쓰기 토큰」 이분법이고, 쓰기를 둘 이상에게 주면 **락 없이 키가 그냥 섞인다**. 우리가 요청-승인 모델을 만들면 그건 차용이 아니라 **선행**이다 — 베낄 UX가 없다는 뜻이고, 설계 비용을 우리가 전부 낸다는 뜻이다.

---

## 1. 현행 능력 경계표 — 있다 / 없다 / 근거

### 1.1 전체 지형: oort에는 터미널 평면이 이미 **둘** 있다

```
평면 A — 영속 제어 (work_control)           평면 B — 직결 스트림 (terminal/display attach)
  클라 → REST → PG → (호스트가 폴)            클라 → REST(권한만) → PG(grant+감사)
  payload {text} 1..32768자                          ↓
  승인 사다리·감사·상태 원장                   60초 bearer + 호스트 자신의 endpoint
  지연 = 폴 주기 (초 단위)                            ↓
  현재 주체: **에이전트 bearer 전용**            클라 ⇄ 호스트 직결 WSS/WebRTC
                                              momo는 바이트를 1개도 나르지 않는다
```

이 분리는 사고가 아니라 결정이다. `routes/terminal_attach.rs:9-16`:

> momo mints a bearer and answers whether one is still good. It does not carry a byte: no stream, no websocket, no stdin, no resize, no relay. … This is what keeps `docs/security/README.ko.md`'s "실행 내용 미보관" literally true rather than aspirational.

### 1.2 축 A-1 — 세션 출력은 어떻게 스트리밍되는가

| 질문 | 판정 | 근거 |
|---|---|---|
| 서버가 stdout을 중계하는가 | **아니다** | `server-rust/crates/momo-t3/src/terminal_attach.rs:34-46` — "There is deliberately no stream, socket, signalling or relay function in this crate" |
| 구독 경로 | `POST /v1/workspaces/{ws}/work-sessions/{session}/terminal-attach` `{mode}` → `{attach_endpoint, capability_token, pty_id}` → 클라가 **호스트 endpoint에 직결** | `routes/terminal_attach.rs:129-175`, `packages/momo-core/src/lib/api.ts:2589-2607` |
| 호스트 측 검증 | `POST …/work-hosts/{host}/terminal-attach/validate` — **PUBLIC 라우트**, Ed25519 host-signed(bearer 없음). 스트림 중 **30초마다 재검증** | `routes/terminal_attach.rs:18-26`, `lib.rs:1084` |
| 재검증이 무엇을 다시 보는가 | **만료 절 하나만** 완화하고 나머지 인가 술어 전부 재평가 — 세션 종료·호스트 revoke·멤버 비활성·채널 이탈이 **한 주기 안에 반영** | `terminal_attach.rs:590-663` (join 전문) |
| 토큰 저장 형태 | 원문 미저장. `digest(token,'sha256')`만 — DB 덤프로는 터미널을 열 수 없다 | `terminal_attach.rs:470-500`, `023_terminal_attach.sql:24-38` |
| TTL | 60초(다이얼 창). 재검증은 이 절을 건너뜀 — 스트림 수명은 인가가 결정 | `CAPABILITY_TTL_SECONDS = 60`, `terminal_attach.rs:72` |
| 관전 스코프 (observer) | `observation = 'open'` **AND** 해당 **채널의 활성 멤버십** | `terminal_attach.rs:643-660`, `routes/terminal_attach.rs:232-247` |
| 조작 스코프 (controller) | `c.owner_member_id = ws.member_id` — **세션 소유자 단 한 명** | `terminal_attach.rs:641`, `routes/terminal_attach.rs:225-231` |
| 관전 사실의 고지 | outbox → Centrifugo `work.session.observer` 브로드캐스트. **카운트만 실린다 — 누가 보는지는 실리지 않는다** | `routes/terminal_attach.rs:104-123` (payload에 `observer_count`만) |

### 1.3 축 A-2 — 워크스페이스 전체 세션 목록은 이미 가능한가

**가능하다. 이것이 TC-2에서 가장 좋은 소식이다.**

| 질문 | 판정 | 근거 |
|---|---|---|
| 라우트 | `GET /v1/workspaces/{ws}/work-sessions?active=0|1` | `lib.rs:757`, `routes/work_sessions.rs:5-8` |
| 인가 술어 | **`membership` JOIN 하나** — 내가 아직 멤버인(`left_at IS NULL`) 채널의, **아카이브 안 된 채널의, 소유자 무관 전체 세션** | `crates/momo-t3/src/lifecycle.rs:788-818` |
| 상한 | `LIMIT 200`, `ORDER BY started_at DESC, id DESC`. **커서 없음** | `lifecycle.rs:806-808` |
| 행에 실리는 것 | id·channel·member(소유자)·host·tool·label·status·**observation**·**observer_grant_count**·`remote_attach_available`·`remote_display_available`·**`control_started_at_ms`**(지금 누가 키보드를 쥐고 있나)·시작/종료 ms·exit_code·계보 | `lifecycle.rs:747-782`, `WS_ATTACH_AVAILABILITY:528-530`, `WS_CONTROL_PROJECTION:555-562` |
| 웹에서 이미 쓰는가 | **그렇다.** `WorkConsoleRoute`가 워크스페이스 스코프로 그린다(`#1289`). `scopeSessions(rows,"all")` | `clients/web/src/features/workConsole/WorkConsoleRoute.tsx:54-66`, `packages/momo-core/src/features/work/workSessionModel.ts:819-834` |

> **판정: 「herd처럼 전반 트래킹」의 서버 계약은 이미 100% 서 있다.** 상태 어휘(running/idle/orphaned/ended), 관전자 수, 조작 중 표시, 호스트 위치(T1/T2/T3)까지 한 응답에 실린다. TC-2 트래킹 절반은 **UX 티켓**이지 ADR 사안이 아니다. ADR이 필요한 것은 오직 §1.5의 조작권과 §1.6의 갭이다.

### 1.4 축 A-3 — 권한이 role로 갈리는가 (guest/member/admin)

| 질문 | 판정 | 근거 |
|---|---|---|
| role 어휘 | `owner / admin / member / guest` (PG enum) | `server/Migrations/001_init.sql:14`, `momo-auth/src/workspace_authorization.rs:27-45` |
| 세션 목록에서 role이 갈리는가 | **아니다.** 목록 인가는 **채널 멤버십 하나**다. guest도 그 채널 멤버면 전부 본다 | `lifecycle.rs:800-805` — role 술어 없음 |
| 관전에서 role이 갈리는가 | **아니다.** `active_workspace_role(...).is_none()` 즉 **"활성 멤버인가" 부울 하나**만 보고, 등급을 보지 않는다 | `routes/terminal_attach.rs:212-218` |
| 조작에서 role이 갈리는가 | **아니다.** role이 아니라 **소유자 동일성**으로 갈린다 | `routes/terminal_attach.rs:225-231` |
| RLS는 무엇을 강제하는가 | **워크스페이스 격리 하나뿐**(`ws_isolation`). 세밀 인가는 전부 앱 계층 JOIN | `023_terminal_attach.sql:45-58`, `020_work_control.sql:88-100` |

> **경계 판정:** oort의 작업세션 권한은 **역할 기반이 아니라 소유·멤버십 기반**이다. TC-2가 「admin은 팀원 터미널을 조작할 수 있다」로 가면 그건 **이 시스템에 없던 축을 새로 여는 것**이고, ADR 사안이다. 반대로 「소유자가 지명한 사람」으로 가면 기존 축(소유) 위에 서므로 훨씬 싸다.

### 1.5 축 A-4 — 입력 주입 경로는 존재하는가 (4갈래로 나눠야 정확하다)

| # | 경로 | 판정 | 근거 |
|---|---|---|---|
| ⓐ | 사람 → **자기** 세션 PTY (stdin/resize/kill) | **서버에 있다.** 웹 클라에는 **없다** | 서버: `AttachMode::Controller`, `terminal_attach.rs:100-112`. 웹: `observerStream.ts:5-18` — *"there is no encoder for `send_stdin`, `resize` or `kill` anywhere in this client … it is not a guard someone can delete by accident, it is an absence"* |
| ⓑ | 사람 → **남의** 세션 PTY | **0** | `routes/terminal_attach.rs:225-231` → 403 `only the session owner can attach as controller`. DB 재검증에서도 같은 술어(`terminal_attach.rs:641`) |
| ⓒ | 사람 → **자기** 세션 **화면**(WebRTC) | **있다 — 웹에 완성되어 있다** | `issueControllerDisplayAttach` (`api.ts:2708-2733`) → `controlStream.ts` + `DisplayController.tsx`. **입력 데이터채널은 producer가 연다**, 클라는 `createDataChannel`을 갖지 않는다(`controlStream.ts:20-31`). 역시 **소유자 전용**(`routes/display_attach.rs:283-287`) |
| ⓓ | **에이전트** → 세션 (줄 단위 입력) | **있다. 단 사람은 못 쓴다** | `POST /v1/workspaces/{ws}/work-controls` kind=`input`, payload `{text}` 1‥32768자. **agent bearer 전용** — 사람 bearer는 403 `work controls require an agent bearer` (`routes/work_controls.rs:170-178`). 호스트가 `GET …/work-hosts/{host}/pending-controls`로 **끌어간다**(`lib.rs:736`) |

**ⓒ가 TC-2의 진짜 선례다.** LIVE-5 / ADR-0004 증보 3이 만든 `display_control_window`는 이미 「사람이 키보드를 쥐는 act」의 원장을 갖고 있다 — 여는 순간 **에이전트의 서버 경로가 거부**되고, 세션이 **`owner_only`로 강제 전환**되며(=관전자 차단), **90초 리스**로 자동 만료되고, 종료 사유(`returned` / `expired` / `session_ended`)가 남는다.

> `display_control.rs:44-53` — *"the whole point of a control window is a person typing a password, and a teammate who pressed 관전 a minute earlier is watching that happen."*

**이 문장이 TC-2와 정면 충돌한다.** oort는 이미 「조작 중에는 남이 못 본다」를 정본으로 결정했다. TC-2는 「남이 조작한다」를 요구한다. 두 문장을 같은 시스템에 둘 수 있는가가 이 ADR의 급소다(→ D4).

### 1.6 축 A-5 — TC-2 이전에 **이미 깨져 있는 것 3종** (최중요)

이 셋은 리서치 부산물이 아니라 **TC-2의 선결 조건**이다.

#### 갭 ①: Rust 서버에 PTY 바인딩을 쓸 주체가 **없다** → 관전이 원리적으로 불가

`work_session.pty_id` / `attach_endpoint`에 값을 쓰는 문장이 `server-rust/` 전체에 **0건**이다. 그리고 두 입구가 명시적으로 거절한다:

```rust
// server-rust/bins/momo-server/src/routes/work_sessions.rs:172-176  (create)
// server-rust/bins/momo-server/src/routes/work_sessions.rs:383-387  (PATCH)
if request.pty_id.is_some() || request.attach_endpoint.is_some() {
    return Err(ApiError::bad_request(
        "remote PTY binding requires work host signature",
    ));
}
```

`work_sessions.rs:36-40`이 이유를 적어 둔다 — 호스트 서명 팔(lifecycle 전이·ACP 이벤트·observation·remote-PTY 바인딩)이 **통째로 미이식**이다. **display 쪽만** host-signed `POST …/work-sessions/{session}/display-binding`이 실존한다(`lib.rs:810`); PTY에는 대응 라우트가 **없다**.

귀결: `remote_attach_available = (pty_id IS NOT NULL AND attach_endpoint IS NOT NULL)` (`lifecycle.rs:528-530`)가 **현행 Rust 서버에서 항상 false**다. TC-1 관전 도크·`ObserverTerminal`·capability 발급·호스트 validate 라우트 — **전부 생산자 없는 소비자**다.

> **이것이 「TC-1이 관전으로 축소된 진짜 이유」를 재정의한다.** 원인은 "웹에 입력 인코더가 없어서"만이 아니다. **서버에 PTY를 등록할 길 자체가 없다.** 그리고 레포에 호스트 데몬 바이너리도 없다(`server-rust/bins/` = agent-worker·migrate·notifier·relay·server·webhook-sender). #857(데몬 셸 래핑·링버퍼·replay)은 Swift 시대 목표였다.

#### 갭 ②: 소유자의 관전 차단 스위치가 **400을 뱉는다** → 동의 모델이 열린 채 잠김

```sql
-- server/Migrations/024_observer_attach.sql:9-12
ALTER TABLE work_session
  ADD COLUMN observation text NOT NULL DEFAULT 'open',
  ADD CONSTRAINT work_session_observation_ck CHECK (observation IN ('open','owner_only'));
```

기본값이 `open`이다(ADR-0126 D1이 "채널에 스레드가 이미 공개인 것과 정합"으로 정당화). 그런데:

```rust
// server-rust/bins/momo-server/src/routes/work_sessions.rs:399-402
if request.observation.is_some() {
    return Err(ApiError::bad_request(
        "observation updates are not served by momo-server yet",
    ));
}
```

그리고 웹은 「팀원 관전 허용」 토글을 **이미 그리고 실제로 호출한다** — `clients/web/src/features/work/ObserverTerminal.tsx:766` → `setWorkSessionObservation` (`api.ts:2557-2569`).

`work_session.observation`을 쓰는 문장은 서버 전체에서 **`display_control.rs` 하나**뿐이고(제어창이 열릴 때 `owner_only`로 뒤집고 닫을 때 되돌린다 — `display_control.rs:397-425`), 그것은 사람이 부를 수 있는 스위치가 아니다.

> **판정: 모든 세션이 기본 공개이고, 소유자에게 그것을 닫을 방법이 현재 없다.** 조작권을 논하기 전에 **관전의 동의 모델부터 고쳐야 한다.** 이건 TC-2 결정이 아니라 **버그**다.

#### 갭 ③: 감사 행은 쓰이지만 **읽을 라우트가 없다**

| 사실 | 근거 |
|---|---|
| grant마다 감사 행이 **같은 트랜잭션**에 쓰인다 | `routes/terminal_attach.rs:257-274` — `work.terminal_attach.issued`, schema `momo.work.terminal_attach.issued.v1`, detail에 `owner_member_id`·`mode`·`issued_at`·`expires_at` |
| display도 동일 | `routes/display_attach.rs:114-118` — `work.display_attach.issued` |
| 읽는 라우트 | **Rust 서버에 없다.** `GET /v1/workspaces/{workspaceId}/audit`는 `docs/api/openapi.yaml:643-667`에만 존재하고 `lib.rs` 라우트 표에 등재되어 있지 않다 |
| 스펙상 권한 | 있더라도 **owner/admin 전용**(`summary: Read the tenant audit ledger (owner/admin only)`) |

> **판정: 내 터미널을 누가 언제 봤는지 당사자가 확인할 방법이 제품 안에 없다.** 원격 **조작**을 열면 이 부재는 부인방지 실패로 승격한다.

### 1.7 인접 정본 — 이미 결정되어 있어서 다시 결정하면 안 되는 것들

| 결정 | 내용 | TC-2에 주는 것 |
|---|---|---|
| **ADR-0126 D4 (v1 예약)** | `work_session.owner_kind: member|workspace`. workspace 소유 세션은 **admin이 operator를 위임/교대**하고 **controller capability가 operator에게 발급**된다 | **TC-2 소유권 절반의 예약석.** 2026-07-21에 성재가 방향을 이미 승인했고 v1으로 미뤘을 뿐이다. TC-2 ADR은 "새 경계"가 아니라 **"D4 실행 + 확장"**으로 기안할 수 있다 |
| **ADR-0125 D10** | 원격 PTY attach는 **서버 raw 비경유** 직결. 서버 중계(B안)는 **기각**. 단 *"직결 불가 망(엄격 방화벽)에서는 서버 중계 폴백이 필요할 수 있으나 그 경우에도 E2E 암호화로 서버가 평문 raw를 못 보게(후속 결정)"* | 도달성 문제는 **이미 인지된 미결**이다. TC-2가 그 후속 결정을 소환한다 |
| **ADR-0004 증보 3 / LIVE-5** | 제어창 = 에이전트 차단 + `owner_only` 강제 + 90초 리스 + 종료사유 원장. 키·프레임·비밀번호는 **둘 곳 자체가 없다** | 「사람이 키보드를 쥔다」의 원장 문법이 이미 있다. 사람→사람으로 확장할 때 **재사용 대상 1순위** |
| **ADR-0149 (휘발 신호)** | PG 미접촉·outbox 우회·**서버가 직접 Centrifugo publish**. 가드 5종. **클라 publish는 계속 닫는다**(기각 B) | 방화벽 폴백 평면의 **완성된 설계 템플릿** |
| **ADR-0154 D3 / 「인수」** | 호스트 상실 후 새 호스트로 **계보 재개**. 자격 = 앵커 채널 활성 멤버십 — **소유자가 아니어도 된다** | ⑴ **「인수」라는 낱말이 이미 점유되어 있다** — TC-2는 다른 낱말을 써야 한다 ⑵ **세션에 대한 교차-멤버 act의 선례가 이미 있다**(`work_sessions.rs:794-800`) |

### 1.8 전송 평면 사실 확인

| 사실 | 근거 |
|---|---|
| Centrifugo 전 네임스페이스에 **클라 publish 권한 없음** — `subscribe_proxy_enabled`만 | `infra/centrifugo.json`, `infra/prod/centrifugo.prod.json` — `allow_publish*` 0건 |
| Centrifugo에 publish하는 주체는 relay(=outbox 소비자)와, ADR-0149 이후 **API 서버 직접 publish** 둘 | `momo-relay/src/centrifugo.rs`, `routes/ephemeral.rs` |
| 휘발 평면 선례 실측 | `routes/ephemeral.rs:1-56` — grant 라우트(PG 1회 읽기, 60초 HMAC, member+channel 바인딩) + publish 라우트(**PG 쿼리 0건**, 테스트로 못박음: `tests/ephemeral_typing_touches_no_pg.rs`) |
| Tauri CSP `connect-src`가 넓은 이유 = **관전 터미널이 momo와 무관한 호스트 엔드포인트를 직접 문다** | `docs/security/README.ko.md:68` |

---

## 2. 레퍼런스 행동 계약 비교표

### 2.1 입력권·동의·중단 (웹 리서치, 2026-08 시점)

| 도구 | 동의 게이트 | **입력권 모델** | 피조작자 고지 | 중단(kill switch) | 신뢰 경계 |
|---|---|---|---|---|---|
| **tmate** | 없음 — 토큰 소지가 곧 권한 | RO 토큰 / RW 토큰 **이분법**. RW 다수면 자유 동시 | 없음 | **세션 통째 종료만.** 개별 게스트 축출 불가 | 릴레이가 **평문을 본다**(자기 문서가 인정) |
| **tmux** | 소켓 `chmod` | **없음.** `attach -r`는 클라 측 관례일 뿐 — 재접속하면 쓰기 가능 (upstream #333: *"as soon as the socket becomes group-write-accessible, full write access cannot be stopped"*) | 없음 | chmod/kill 전체 | 직결(릴레이 없음) |
| **GNU screen** | `acladd` / `aclchg` (소유자 발급) | **`writelock` — 유일한 진짜 단일-writer 락.** `auto` 모드에서 창에 먼저 포커스한 사람이 암묵 배타권을 갖고, 떠나면 넘어간다 | 없음(사회적 가시성만) | **`aclchg user -w` 즉시 회수** — 세션 안 죽여도 됨 | 직결 |
| **VS Code Live Share** | 게스트 합류 시 호스트 알림 + `liveshare.guestApprovalRequired` 사전승인 옵션 | 터미널 단위 RO/RW를 **호스트가 공유 시점에 선택**. RW면 **락 없이 전원 동시 입력**(MS가 이를 *기능*으로 명시 — "개입하기 쉽다") | **있다** — 합류 토스트 + 참가자 패널 | **참가자 패널 "Remove" 즉시 축출**(라이브) | E2E SSH-over-relay, 릴레이는 **암호문만** |
| **Warp (Agent Session Sharing)** | 발행자가 링크에 등급 부여 | **View / Edit 이분법.** Edit 다수면 자유 동시(각자 커서) | 뷰어 아바타 표시 | **발행자만** 회수·발행 중단 가능 | 문서 미상세 |
| **upterm** | `--read-only`를 호스트 기동 시 결정 | 세션 단위 단일 모드(중간 전환 없음). 파일 전송만 **건별 승인** | 파일 전송 승인 프롬프트 | 세션 종료 | 릴레이(uptermd) 신뢰 필요 |
| **gotty** | 기본 **읽기전용**, 쓰기는 `-w` 명시 | `-w`면 자유 동시 | 없음 | 프로세스 재시작 | **기본 평문**(README가 경고) |
| **ttyd** | **기본 인증 없음** | 자유 동시 | 없음 | 방화벽 | Auth-Proxy 모드는 `X-WEBAUTH-USER`를 무조건 신뢰 |
| **sshx** | **없음 — 권한 등급 자체가 없다** | 자유 동시, 멀티커서, 무한 캔버스에 페인 임의 생성 | 커서 라벨 | **개별 회수 불가**, 세션 종료만 | E2E(Argon2+AES) — 릴레이는 암호문만 |
| **Zellij multiplayer (v0.44+)** | RO 토큰 / full-access 토큰 | full-access 다수면 **락 없이 같은 PTY에 raw 키 인터리브** | 없음 | CLI로 토큰 회수 | 웹 클라는 사용자 제공 인증서 필요 |

### 2.2 이 표에서 나오는 세 개의 교훈

**교훈 1 — 요청-승인 단일 writer 모델은 업계에 사실상 없다.**
조사한 10종 중 실제 중재를 가진 것은 **GNU screen의 `writelock` 하나**다. 그마저도 요청-승인이 아니라 **포커스 기반 암묵 락**(창에 먼저 들어간 사람이 갖고, 나가면 놓는다)이다. 나머지 전부 「RO 토큰 / RW 토큰」이고, RW를 둘에게 주면 **소프트웨어가 아니라 사회적 합의로 충돌을 처리한다**("동시에 치지 말자").
⇒ TC-2가 요청-승인을 하면 그건 **차용이 아니라 선행**이다. 베낄 UX가 없고, 설계·검증 비용을 전부 우리가 낸다. 반대로 이분법을 택하면 업계 전체가 검증한 길이지만, **oort가 다른 모든 표면에서 지켜 온 「모든 개입은 승인 원장을 남긴다」(ADR-0114 D5)와 어긋난다.**

**교훈 2 — 「중단」의 품질이 도구를 가른다.**
tmate·sshx·upterm은 개별 회수가 **불가능**하고 세션을 죽여야 한다. Live Share와 GNU screen만이 **세션을 유지한 채 한 사람의 권한을 즉시 회수**한다. oort는 여기서 **이미 유리하다** — 재검증 JOIN이 30초마다 인가 전체를 다시 계산하므로(`terminal_attach.rs:590-663`), grant 행 하나를 지우거나 술어 하나를 뒤집는 것만으로 **한 주기 안에 한 사람을 끊을 수 있다**. 이걸 표면으로 노출하기만 하면 업계 최고 수준의 kill switch가 공짜로 선다.

**교훈 3 — 고지(피조작자가 안다)가 업계의 최대 공백이다.**
tmate·tmux·screen·sshx·Zellij·gotty·ttyd 전부 **합류 알림이 없다**. Live Share만 토스트+패널을 준다. oort의 현행 고지도 **카운트뿐**(`observer_count`), 신원이 없다. 원격 조작에서 신원 없는 고지는 무의미하다.

### 2.3 보안 사고·오용 전례

| 사건 | 교훈 |
|---|---|
| **CVE-2021-44512 / 44513** (tmate-ssh-server, 자체 호스팅 릴레이) — `/tmp/tmate/sessions`가 world-writable이라 **RO 토큰 소지자가 심볼릭 링크로 RW 소켓에 도달**해 읽기전용을 완전 제어로 승격. 별건으로 `mkdir`/`chmod` 경쟁 조건 | **"읽기전용"이 파일시스템 권한 위에 얹힌 관례면 그것은 권한이 아니다.** oort가 이 함정을 피하는 방식: 등급이 **DB CHECK + 재검증 JOIN 술어**이고 클라에는 인코더 자체가 없다(`observerStream.ts`의 "absence" 논증) |
| **tmate = 멀웨어 C2** (TeamTNT 등) — 침해 호스트에 tmate 바이너리를 심어 정상 로그인 흔적을 우회하는 대화형 백도어 확보 | 터미널 공유 도구는 **아웃바운드 전용 역방향 셸**이다. oort의 work_host는 이미 outbound-only(ADR-0125 D1)이므로 **같은 성질을 갖는다** — 즉 우리도 침해 시 같은 도구가 된다. host revoke의 즉시성이 방어선 |
| **tmux upstream #333** — `attach -r`가 **강제되지 않는다**는 것을 upstream이 공식 인정 | 클라 측 플래그를 권한으로 믿지 말 것 |
| **ttyd / gotty 무인증 노출** — 기본 인증 없음(ttyd) 또는 평문(gotty)으로 인터넷에 방치되는 것이 반복 노출 계열. NCC Group/Fox-IT가 ttyd 원격 셸 실행 이슈 권고 발행 | `attach_endpoint`는 **credential-free https/wss만 허용**하고 userinfo/query/fragment를 거부한다(`terminal_attach.rs:290-315`) — 이 규율이 정확히 이 계열을 막는다 |
| **VS Code Live Share 자체 경고** — *"Live Share allows guests you invite to run console/REPL commands and there is therefore a risk of a malicious actor running a command you would not want them to run… you should only co-debug with those you trust."* | MS조차 **기술적 해결을 포기하고 신뢰로 넘긴다.** 공유 터미널 = **임의 명령 실행 위임**이라는 사실은 어떤 UX로도 축소되지 않는다 |
| **레포 내 1차 사고 — herdr 스파이크(2026-08-06)** | **가장 중요한 전례.** `research/2026-08-06-herdr-spike.md` §3.4 / §7-1: herdr가 페인을 `idle`로 **오분류**한 상태에서 `agent prompt`로 텍스트+Enter를 주입했는데, 그 페인은 실제로 codex "Update available" 모달이었고 기본 선택지 **`1. Update now`가 확정**되어 **사용자 전역 codex CLI가 0.144.1 → 0.146.1로 무단 업그레이드**됐다. 미복구 상태로 기록됨 |

> **herdr 사고의 함의는 이 리서치 전체에서 가장 무겁다.** 「보이지 않는 터미널에 텍스트를 밀어넣는 것」은 그 순간 화면에 무엇이 있는지 모른 채 **Enter를 누르는 것**이다. 상태 감지는 도움이 안 된다 — 우리 실측 blocked 재현율은 **1/5**였고 비대화형 워커는 **32초 내내 idle로 오분류**됐다(§3.2). ⇒ **원격 조작의 안전은 "상대 상태를 잘 맞히기"로 얻을 수 없다. 조작 순간 조작자가 그 화면을 실제로 보고 있어야 한다**(→ D6).

### 2.4 herd / orca — 성재의 레퍼런스가 실제로 무엇인가

| 제품 | 정체 | 다자 공유 모델 |
|---|---|---|
| **herdr** (`herdrdev/herdr`, Rust, Apache-2.0 ≥v0.8.0) | "에이전트 인식 tmux". 데몬이 세션 소유(재부팅 생존), 워크스페이스>탭>페인, 페인별 idle/working/blocked/unknown 배지, `agent explain`이 판정 근거 설명, Unix 소켓 JSON API(method 149종) | **없다.** 단일 운영자의 자기 플릿 관제 도구. 읽기전용/쓰기 등급도, 게스트 승인도, 회수 UX도 문서에 없음 |
| **Orca** (`stablyai/orca`, YC, MIT) | ADE — 같은 과제를 여러 코딩 에이전트에 격리 worktree로 병렬 실행하고 diff로 승자 선택. 데스크톱/모바일/VPS 클라로 "폰에서 내 에이전트들을 감시·조종" | **없다.** 단일 운영자 fan-out + steer |

> **정직한 판정: herd·orca는 「내 여러 터미널을 한 자리에서 본다」를 푼 도구이지, 「남의 터미널을 본다/친다」를 푼 도구가 아니다.** 성재 구상의 **트래킹 절반은 herd/orca가 정확한 레퍼런스**(상태 배지·어디서든 재접속·폰 관제)이고, **조작 절반은 herd/orca에 답이 없다** — 그쪽 레퍼런스는 Live Share·Warp·GNU screen이다. 두 절반을 한 제품 이름으로 묶어 생각하면 조작 절반의 설계 난이도를 과소평가하게 된다.

레포 실측이 이미 붙어 있는 부분(`2026-08-06-herdr-spike.md` §6):
- ✅ 채택: 상태 어휘 3종 + **"blocked만 푸시"** 정책 · 워커 자기보고(push) 모델 · 소켓→REST 릴레이 형태 · **`explain`형 "판정 근거 설명" UX**
- ❌ 불채택: herdr = 상태 감지기(blocked 재현율 20%, 비대화형 워커 0%) · fleet 필수 의존(1인 프로젝트, 감지 룰이 **원격에서 자동 갱신**)

---

## 3. 핵심 긴장 — 재정의와 해소안 비교

### 3.1 먼저: 긴장이 제기된 형태는 틀렸다

발제문의 긴장은 *"터미널 입력은 고빈도·저지연인데 oort는 단일 쓰기경로 불변식을 갖는다. 키 입력을 그 경로로 보내는 것이 성립하는가?"*였다.

**성립하지 않고, 성립시킬 필요도 없으며, 시도된 적도 없다.**

| 근거 | 출처 |
|---|---|
| 단일 쓰기경로는 **영속 상태**의 경로이지 신호의 경로가 아니다 — 이미 ADR로 명문화 | ADR-0149: *"단일 쓰기경로(REST→PG→outbox→relay)는 **영속 상태**를 위한 경로다. 휘발 신호를 여기 태우면 outbox가 쓰레기로 차고, relay 지연이 **실제 메시지**에 전가된다."* |
| 터미널 바이트의 서버 비경유는 **2026-07-20에 이미 결정** | ADR-0125 D10-A. B(서버 중계 프록시)는 **기각** |
| 그 결정이 코드에 물리적으로 각인되어 있다 | `terminal_attach.rs:34-46` — 이 crate에 stream/socket/relay 함수가 **존재하지 않는다** |

**그래서 진짜 질문은 이것이다:**

> **원격 조작의 ①권한 ②동의 ③감사를 어디에 영속시킬 것인가. 그리고 바이트는 어느 평면에 둘 것인가. 두 평면이 어긋날 때(권한은 끊겼는데 소켓은 살아 있다) 무엇이 이기는가.**

세 번째 절이 실질적 난제다. 현행 답은 **30초 재검증**이다 — 권한이 이긴다, 단 최대 30초 지연으로. 원격 조작에서 30초는 긴 시간이다(→ D8).

### 3.2 지연 예산 — 무엇이 성립하고 무엇이 안 하는가

| 사실 | 수치 | 출처 |
|---|---|---|
| 지속 타이핑 이벤트율 | 평균 52 WPM ≈ **4~4.3 keystroke/s**; 숙련(80+ WPM) **7~9/s** 버스트 | Aalto 136M keystroke·168k 참가자 연구 |
| 인지 임계 | 통념 ~100ms, 그러나 **상호작용 빈도에 반비례** — 빠른 타이피스트는 100ms보다 훨씬 낮은 값을 감지 | "Are 100 ms Fast Enough?" (Springer 2017) |
| 로컬 터미널 실측 | 중앙값 5~44ms, **부하 시 p99.9 = 32~111ms**. 10 char/s 타이핑이면 **~100초마다 그 꼬리를 만난다** | danluu.com/term-latency |
| "고장 난 느낌"의 실증 기준선 | 원거리 SSH 키-에코 중앙값 **503ms**. mosh는 **예측 로컬 에코**로 >70%를 왕복 전에 렌더해 이를 해결 | mosh USENIX 논문 |
| 업계 공통 해법 | 응답성 있다고 평가받는 도구는 **전부 hot echo 경로를 내구성 경로 밖에 둔다** — 로컬 PTY 에코 또는 예측 에코 후 사후 정정(sshx도 README에 "Predictive echo… à la Mosh" 명시) | §2 조사 전반 |

**⇒ 4~9 events/s를 HTTP POST → PG commit → outbox → relay로 나르는 안은 산수로 기각된다.** outbox 행 부담은 ADR-0149의 계산(타이퍼 1명 3초 주기 5분 = 100행)보다 **한 자릿수 이상 크고**, 커밋 왕복이 인지 임계를 넘는다.

### 3.3 해소안 비교

#### 해소안 1 — 평면 분리 유지: 권한만 SoT, 바이트는 직결 **(권고)**

기존 capability 모델에 **등급을 하나 더** 얹는다. `mode ∈ {controller, observer}`에 세 번째를 추가하거나, controller의 술어 `c.owner_member_id = ws.member_id`를 **"소유자 OR 유효한 위임을 가진 자"**로 넓힌다. 바이트 경로는 **한 글자도 바뀌지 않는다**.

| 항목 | 판정 |
|---|---|
| 지연 | 클라↔호스트 1 RTT. LAN 수 ms, 원거리 수십 ms. **성립** |
| Postgres = SoT | **유지** — 위임 원장이 PG에 새로 생기므로 오히려 강화 |
| 단일 쓰기경로 | **유지** — PG 쓰기는 REST 하나. 바이트는 애초에 이 경로를 안 지난다 |
| Centrifugo 전송전용 | **유지** — 고지 브로드캐스트만 outbox 경유 |
| RLS FORCE | **유지** — 위임 행이 `ws_isolation` 아래 들어옴 |
| 자격증명 비유입 | **유지** — momo는 여전히 바이트를 못 본다 |
| 구현 비용 | **낮다.** 새 테이블 1개(위임 원장) + 재검증 JOIN 술어 확장 + 감사 액션 1~2종 + 웹 controller 인코더(현재 부재) |
| 남는 문제 | ⑴ **도달성** — 팀원 B의 브라우저가 팀원 A의 맥(T1)에 직접 닿는가? T3(클라우드)는 공개 endpoint라 됨. **T1/T2는 대체로 안 됨** ⑵ 웹에 controller 인코더를 처음 만드는 일 자체가 `observerStream.ts`가 지켜 온 "absence" 계약을 깨는 act — 별도 모듈+별도 리뷰가 필요(display 쪽 `controlStream.ts`가 정확히 그 선례) ⑶ **갭 ①이 선결**(PTY 바인딩 라우트가 없으면 이 안 전체가 공중에 뜬다) |

#### 해소안 2 — ADR-0149형 휘발 제어 채널 (방화벽 폴백 전용)

직결이 불가한 망에서만. 서버를 지나되 **PG는 건드리지 않는다**: grant 라우트(PG 1회 읽기 + HMAC)로 인가를 앞당기고, 프레임 라우트는 쿼리 0건으로 Centrifugo에 흘린다. ADR-0149의 5개 가드를 그대로 승계.

| 항목 | 판정 |
|---|---|
| 지연 | 클라→서버→Centrifugo→호스트 = 2~3 hop. **성립 가능하나 마진이 얇다.** 서버 rate limit이 사실상 상한 |
| Postgres = SoT | **유지** — 프레임은 상태가 아니다 |
| 단일 쓰기경로 | **유지** — 아무것도 안 쓴다 |
| Centrifugo 전송전용 | **유지되나 비용 발생** — 발신자가 relay+API 서버에서 **셋으로** 는다(ADR-0149가 "이 결정의 유일한 실질 비용"이라 부른 그것의 재발) |
| RLS FORCE | **⚠ 주의** — ADR-0149가 가장 깨지기 쉽다고 지목한 자리. PG를 안 지나므로 격리가 공짜가 아니다 |
| 자격증명 비유입 | **❌ 정면 위반 위험.** 서버가 **평문 키스트로크를 보게 된다**. ADR-0125 D10-B의 기각 사유가 그대로 재발하고, `docs/security/README.ko.md`의 "실행 내용 미보관"이 문면 그대로는 거짓이 된다 |
| 완화 | **E2E 암호화 필수** — ADR-0125 D10 경계가 이미 *"그 경우에도 E2E 암호화로 서버가 평문 raw를 못 보게(후속 결정)"*라고 예고. sshx(Argon2+AES)·Live Share(SSH-over-relay)가 실증한 형태 |
| 비용 | **높다.** 키 협상·회전·클라 3종(웹/데스크톱/폰) 구현. **v0에 넣을 것이 아니다** |

#### 해소안 3 — 기존 `work_control kind=input` 재사용 (줄 단위 제출)

`{text}` 1‥32768자를 **줄/명령 단위**로 제출. 감사·상태 사다리·승인 고리가 **이미 있다**.

| 항목 | 판정 |
|---|---|
| 지연 | POST → PG commit → **호스트 폴** = **초 단위**. 대화형 타이핑 **불가** |
| 무엇에 쓰이나 | TUI 조종이 아니라 **"이 세션에 이 지시를 넣어 줘"**. 성재 구상 중 「끼어들어 방향을 바꾼다」는 이걸로 상당 부분 충족된다 |
| 못 하는 것 | alternate screen TUI(claude/codex의 대화형 화면)·Ctrl-C·탭 완성·비밀번호 프롬프트·페이저 |
| 현재 막힌 것 | **사람 bearer는 403**(`work_controls.rs:177`). 사람에게 여는 것은 그 자체로 새 결정 |
| 불변식 | **전부 유지.** 이미 이 경로로 도는 트래픽이 있다 |
| 비용 | **가장 낮다.** 라우트 인가 팔 하나 + 승인 고리 |
| 위험 | **herdr 사고와 정확히 같은 형태다** — 화면을 안 보고 텍스트+Enter를 밀어넣는 것. 승인 게이트 없이 열면 안 됨 |

### 3.4 권고 조합

```
v0  트래킹만              해소안 없음 (읽기 표면 + 갭 ①②③ 수리)
v1  줄 단위 원격 지시      해소안 3 + 승인 게이트   ← 가장 싸고, herd/orca가 실제로 하는 일에 가장 가깝다
v2  실시간 원격 조작       해소안 1 (직결) + 위임 원장 + 요청-승인
v3  방화벽 폴백            해소안 2 (E2E 전제) — 별도 ADR
```

**해소안 1과 3은 배타가 아니다.** 3은 "무엇을 시킬까"(비동기·감사 강함·저위험), 1은 "직접 손을 댄다"(동기·고위험·좁은 창). 두 낱말을 처음부터 갈라 놓으면 UI가 둘을 한 버튼 뒤에 두는 사고를 막는다(ADR-0139 D3이 reattach와 resume에 대해 한 일과 같은 규율).

---

## 4. 보안 결정 후보

### 4.1 동의 모델 — 세 후보

| 후보 | 내용 | 장 | 단 | 선례 |
|---|---|---|---|---|
| **가. 사전 위임(operator)** | 소유자(또는 workspace-소유 세션의 admin)가 **미리** 조작자를 지명. 지명된 사람은 소유자 부재에도 조작 가능 | ADR-0126 D4에 **이미 예약석**이 있다. 부재 대응이 되는 유일한 안(성재 구상의 실제 동기일 가능성). 구현 최소 | 동의가 **행위 시점이 아니라 설정 시점**에 있다. 위임을 잊으면 상시 노출 | ADR-0126 D4 · Warp 발행자 링크 |
| **나. 요청-승인 (단일 writer 락)** | 조작 희망자가 요청 → 소유자가 승인 → **한 명만** 조작하는 창이 열리고 리스로 만료 | oort의 승인 원장 문법(ADR-0114 D5)과 정합. 모든 개입에 결정 주체가 남는다. **가장 안전** | 소유자 부재 시 **아무도 못 돕는다**(성재 동기와 정면 충돌 가능). **업계에 베낄 UX가 없다**(§2.2 교훈 1) | GNU screen `writelock`(암묵 락)이 유일한 근친 |
| **다. 자유 동시 (RW 등급 부여)** | 등급만 주면 여럿이 동시에 친다 | 업계 표준(Live Share·Warp·sshx·Zellij 전부). 구현 최소 | oort가 지켜 온 「모든 개입은 승인 원장」과 어긋남. 충돌 처리를 사회에 떠넘김 | 업계 다수 |

**혼합안(권고 후보):** **가 + 나** — 상시는 위임(가)로, 위임 없는 급습은 요청-승인(나)로. 자유 동시(다)는 **열지 않는다**. 근거: 터미널은 문서가 아니라 **부작용 있는 명령의 입구**이고, 두 사람이 동시에 Enter를 치는 상태가 안전한 순간이 없다.

### 4.2 자격증명 노출 — 정면 충돌 지점

ADR-0004 증보 3이 이미 결정한 것:
- **증보 3 D2** — 사용자 자격증명은 transcript·audit·Memory Plane·Context Packet 어디에도 유입되지 않는다. `display_control.rs`가 그것을 **"둘 곳이 없게 만드는 방식"**으로 보증한다(*"Keystrokes, frames, screenshots, a password, a 2FA code. 076 has no column that could, and this module has no function that would."*)
- **증보 3 D3 / LIVE-5a(077)** — 제어창이 서면 세션이 **`owner_only`로 강제 전환**된다. 이유가 명문으로 적혀 있다: *"the whole point of a control window is a person typing a password, and a teammate who pressed 관전 a minute earlier is watching that happen."*

**TC-2는 이 결정을 뒤집으라고 요구한다.** 「팀원이 조작한다」는 곧 **팀원이 그 화면을 보면서 친다**는 뜻이고, 그 화면에 비밀번호가 뜰 수 있다.

선택지:
1. **조작 창에서는 자격증명 입력을 금지한다**(사회적 규약 — 강제 불가, MS가 택한 길)
2. **조작 위임 세션은 자격증명 프롬프트를 못 만나게 한다** — L-cred 볼륨이 이미 붙은 세션에서만 위임 허용(ADR-0125 D4의 3계층 합성이 근거를 준다)
3. **위임 조작 중에는 소유자에게 상시 가시 표지**를 띄우고, 소유자가 **한 키로 즉시 회수** — 증보 3의 반대 방향 대칭(관전 차단 대신 소유자 상시 감시)
4. **위임 조작 중 화면을 소유자 자신도 계속 본다**(현재 `owner_only` 강제와 양립)

권고 방향: **2 + 3 + 4의 결합.** 1은 강제력이 없어 결정이 아니다.

### 4.3 감사 / 부인방지

| 결함 | 현행 | 필요 |
|---|---|---|
| grant 감사 | **있다** — `work.terminal_attach.issued` / `work.display_attach.issued`, grant와 같은 트랜잭션 | 조작 등급용 액션 신설(`work.terminal_control.delegated` / `.opened` / `.closed`) |
| 읽기 표면 | **없다** — Rust 서버에 `/audit` 라우트 부재(§1.6 갭 ③) | **최소한 세션 소유자가 자기 세션의 관전·조작 이력을 읽을 수 있어야 한다.** owner/admin 전용 감사와 별개 |
| 신원 고지 | **없다** — `work.session.observer`는 카운트만 | 조작에서는 **신원 필수**. 관전에서도 재검토 대상 |
| 무엇이 남지 않아야 하는가 | 키·프레임·비밀번호 — **둘 곳이 없다**(증보 3 D2) | 이 성질을 **위임 원장에도 그대로 승계**. 위임 행에 payload 칼럼을 만들지 않는다 |
| 조작 종료 사유 | display만 있다(`returned` / `expired` / `session_ended`) | PTY 위임에도 같은 어휘 |

---

## 5. 단계 로드맵

### 0단계 — **선결 수리** (TC-2 ADR과 병행 가능, ADR 불요)

이건 TC-2의 일부가 아니라 **TC-2가 설 바닥**이다. 없으면 §1~§4 전부가 공중에 뜬다.

| # | 항목 | 근거 |
|---|---|---|
| 0-a | **host-signed PTY 바인딩 라우트** — `POST …/work-sessions/{session}/pty-binding` (display-binding의 PTY 쌍둥이). 없으면 `remote_attach_available`가 영원히 false | §1.6 갭 ① |
| 0-b | **observation PATCH 팔 이식** — 소유자가 관전을 닫을 수 있게. 지금 웹 토글이 400을 받는다 | §1.6 갭 ② |
| 0-c | **감사 읽기 표면** — 최소한 세션 소유자가 자기 세션 grant 이력을 읽는 경로 | §1.6 갭 ③ |
| 0-d | (선택) 호스트 데몬의 PTY 생산자 — 레포에 없음. 0-a가 있어도 이걸 채울 주체가 필요 | `server-rust/bins/` 목록 |

### 1단계 — **트래킹만** (조작 0)

- 좌측 작업 콘솔을 herd형 관제 표면으로: 상태 배지(working/blocked/idle/orphaned) · 호스트 위치 · 경과 · 관전자 수 · **조작 중 표지**
- 서버 계약 **신규 없음** — `GET /work-sessions`가 이미 전부 준다(§1.3)
- herdr 실측에서 채택된 규율 승계: **blocked만 푸시** · **`explain`형 판정근거 표기** · 워커 자기보고
- 상한 대응: `LIMIT 200` 커서 없음 → 페이지네이션 필요 여부 판단
- **이 단계에서 성재 구상의 「전반 트래킹」은 완성된다.**

### 2단계 — **요청-승인 원격 조작** (좁은 창)

- 위임/승인 원장 신설. `display_control_window`의 문법 재사용(리스·종료사유·idempotent close)
- controller 술어를 "소유자 OR 유효 위임"으로 확장
- 웹에 controller 인코더 신설 — **별도 모듈·별도 리뷰**(`controlStream.ts` 선례를 따른다)
- 소유자 상시 가시 표지 + 한 키 회수. 회수는 grant 행 삭제 → **재검증 주기 안에 소켓이 끊긴다**
- 재검증 30초가 회수 지연 상한 — 이것이 허용 가능한가가 D8

### 3단계 — **상시 위임 (operator)**

- ADR-0126 D4 실행: `work_session.owner_kind: member|workspace`, admin의 operator 위임/교대
- 도달성 문제(T1/T2)가 여기서 본격화 → 4단계 유발

### 4단계 (별도 ADR) — **방화벽 폴백**

- 해소안 2 + E2E. ADR-0125 D10이 예고한 "후속 결정"의 소환

---

## 6. ADR 기안용 결정 목록

> 표기: **[신규]** = 새 경계 · **[실행]** = 기존 Accepted ADR의 예약분 집행 · **[수리]** = 결정이 아니라 결함

| # | 결정 | 성격 | 후보 | 권고 | 왜 이게 결정인가 |
|---|---|---|---|---|---|
| **D0** | 0단계 선결 3종(PTY 바인딩·observation PATCH·감사 읽기)을 TC-2 **선행 조건**으로 못박는가 | [수리] | 가. 선행 필수 / 나. 병행 / 다. 별건 분리 | **가** | 셋이 없으면 관전이 원리적으로 불가하고(갭 ①), 동의 스위치가 400이며(②), 부인방지가 없다(③). 이 위에 조작권을 얹는 것은 잠금장치 없는 문에 손잡이를 다는 일 |
| **D1** | 「팀 터미널 트래킹」에 **새 서버 계약이 필요한가** | [신규] | 가. 불요(기존 목록 재사용) / 나. 전용 집계 라우트 신설 | **가** | `GET /work-sessions`가 소유자 무관 채널 스코프 전체를 이미 준다(§1.3). 신설은 두 번째 진실 원천을 만드는 일 |
| **D2** | 조작권의 **주체 축**을 무엇으로 하는가 | [신규] | 가. 소유자 위임(소유 축) / 나. workspace role(admin 축) / 다. 채널 멤버십(관전과 동일 축) | **가**(+D9로 나 흡수) | oort의 작업세션 권한은 지금 **역할 기반이 아니다**(§1.4). 나를 택하면 이 시스템에 없던 축을 새로 연다 |
| **D3** | **입력권 모델** | [신규] | 가. 요청-승인 단일 writer / 나. 사전 위임 상시 / 다. 자유 동시 / 라. 가+나 혼합 | **라**, 다는 **명시 기각** | 업계에 요청-승인 선례가 사실상 없다(§2.2 교훈 1) — 우리가 선행한다는 뜻이므로 비용을 인정하고 결정해야 한다. 다는 oort의 승인 원장 문법과 어긋난다 |
| **D4** | **증보 3 D3(조작 중 `owner_only` 강제)을 사람↔사람 조작에서 어떻게 다루는가** | [신규] | 가. 그대로 유지(조작 중 제3자 관전 차단, 소유자는 봄) / 나. 조작자·소유자만 / 다. 완화 | **가 또는 나** | **이 ADR의 급소.** 「조작 중에는 남이 못 본다」가 이미 정본이고 TC-2는 그 반대를 요구한다. 두 문장이 같은 시스템에 서려면 명시적 화해가 필요 |
| **D5** | **바이트 평면** | [신규] | 가. 직결 유지(해소안 1) / 나. 서버 경유 휘발(해소안 2) / 다. 줄 단위 제어(해소안 3) | **v0=다, v2=가, 나는 별도 ADR** | 지연 산수가 나를 v0에서 배제하고(§3.2), 자격증명 비유입이 나에 E2E를 전제로 요구한다 |
| **D6** | 조작자는 **조작 순간 그 화면을 보고 있어야 하는가**(blind injection 금지) | [신규] | 가. 강제(관전 스트림 활성이 조작의 전제) / 나. 권고 | **가** | herdr 사고 실측(§2.3): 화면을 안 본 텍스트+Enter가 `1. Update now`를 확정시켰다. 상태 감지로는 못 막는다(blocked 재현율 1/5) |
| **D7** | **고지에 신원을 싣는가** | [신규] | 가. 조작만 신원 / 나. 관전·조작 모두 신원 / 다. 현행 유지(카운트만) | **가 최소, 나 검토** | 현행은 카운트만(§1.2). 신원 없는 고지는 조작에서 무의미. 관전까지 넓히면 D0-b(관전 차단)와 함께 동의 모델이 완성됨 |
| **D8** | **회수 지연 상한**을 얼마로 두는가 | [신규] | 가. 현행 30초 재검증 그대로 / 나. 조작 등급만 단축(예 5초) / 다. 즉시 끊기(호스트 push 채널 신설) | **나** | 관전 30초는 견딜 만하나 조작 30초는 길다. 다는 새 채널을 요구하므로 비용이 큼 |
| **D9** | **ADR-0126 D4(workspace 소유 세션 + operator 위임)를 지금 실행하는가** | [실행] | 가. TC-2에 흡수 실행 / 나. 계속 v1 예약 | **가** | 2026-07-21에 방향이 이미 승인됐고 v1로 미뤄졌을 뿐. TC-2를 "새 경계"가 아니라 **"D4 실행 + 확장"**으로 기안하면 결정 부담이 크게 준다 |
| **D10** | **낱말** — 이 act를 무엇이라 부르는가 | [신규] | 「인수」는 **사용 불가**(ADR-0154 D3이 호스트 상실 후 계보 재개에 점유) | 신어 필요 | 두 다른 act가 한 낱말을 쓰면 UI가 둘을 한 버튼 뒤에 둔다(ADR-0139 D3의 교훈) |
| **D11** | **v0 범위를 하나로 좁히는가** | [신규] | 가. 트래킹만 / 나. 트래킹+줄 단위 지시 / 다. 전부 | **가 또는 나** | ADR-0149의 규율: *"신호 하나로 가드 5개가 실제로 서는지 먼저 본다. 통로를 뚫는 결정과 통로에 무엇을 흘릴지는 다른 결정이다."* 같은 규율이 여기에도 적용된다 |

### 불변식 대조표 (권고안 = D5-다(v0) → D5-가(v2) 기준)

| 불변식 | 판정 |
|---|---|
| Postgres = SoT | **유지** — 위임·조작창 원장이 PG에 새로 생기므로 강화 |
| Centrifugo = 전송전용 | **유지** — 고지 브로드캐스트만. 클라 publish는 계속 닫힘 |
| 단일 쓰기경로 | **유지** — 바이트는 이 경로를 지난 적이 없고 지나게 하지 않는다 |
| 순서 = `message.seq` | **유지** — 조작은 seq를 소비하지 않는다 |
| 에이전트 = member | **⚠ 검토 필요** — 위임 대상에 에이전트를 포함하는가? 포함하면 "에이전트가 사람 터미널을 친다"가 되고, 이건 별도 결정(현행 `work_control`이 에이전트→자기 세션만 허용) |
| RLS FORCE | **유지**(D5-가/다). **⚠ 주의**(D5-나: PG를 안 지나므로 격리가 공짜가 아님 — ADR-0149가 지목한 가장 깨지기 쉬운 자리) |
| provider 자격증명 비유입(ADR-0004) | **유지**(가/다) / **❌ 위반 위험**(나, E2E 없이는) |

---

## 7. 성재 결정 필요 항목

| # | 물음 | 왜 성재 몫인가 |
|---|---|---|
| **①** | **동기 확인** — 「원격 조작」의 실제 필요는 ⑴ *팀원이 자리를 비웠을 때 대신 이어받기*인가 ⑵ *옆에서 실시간으로 같이 치기*인가 ⑶ *"그 세션에 이 지시 좀 넣어줘"*인가? | 셋의 설계가 **완전히 다르다**. ⑴=위임(D2-가·D9), ⑵=요청-승인 실시간(D3-라·D5-가), ⑶=줄 단위(D5-다, **가장 싸다**). 이 답 없이는 ADR을 기안할 수 없다 |
| **②** | **D4** — 「조작 중에는 남이 못 본다」(증보 3 D3, 이미 정본)와 「팀원이 조작한다」를 어떻게 화해시키는가 | 본인이 승인한 결정을 뒤집거나 좁히는 일 |
| **③** | **D0** — 선결 3종(PTY 바인딩·observation PATCH·감사 읽기)을 TC-2 앞에 세우는 데 동의하는가. 특히 **관전 차단 토글이 400을 뱉는 것은 현행 출시 결함**이다 | 우선순위·트랙 배정. 갭 ①은 관전 자체를 무효화하므로 TC-1의 가치에도 직결 |
| **④** | **D9** — TC-2 ADR을 「신규 경계」가 아니라 **「ADR-0126 D4 실행 + 확장」**으로 기안해도 되는가 | 결정 성격 규정. 승인된 예약분의 집행이면 절차가 가벼워진다 |
| **⑤** | **D11** — v0 범위. 트래킹만인가, 줄 단위 지시까지인가 | 범위는 항상 성재 몫 |
| **⑥** | **자격증명 노출** — 위임 조작 중 화면에 비밀번호가 뜰 수 있다는 사실을 ⑴ 사회적 규약으로 둘 것인가 ⑵ L-cred 붙은 세션에만 위임 허용으로 강제할 것인가 | ADR-0004 경계의 재해석 |
| **⑦** | **호스트 데몬** — 레포에 PTY 생산자가 없다. 이걸 만들 것인가, T3(클라우드) 전용으로 시작할 것인가 | 로드맵 전제. T3 전용이면 도달성 문제(§3.3 해소안 1 단①)도 함께 사라진다 |
| **⑧** | **D10 낱말** — 「인수」가 점유되어 있다. 새 낱말이 필요하다 | 제품 어휘는 성재와 함께 |

---

## 부록 A — 인용 근거 색인 (레포 실측)

| 사실 | 파일:라인 |
|---|---|
| 서버가 터미널 바이트를 나르지 않는다 | `server-rust/crates/momo-t3/src/terminal_attach.rs:34-46` · `server-rust/bins/momo-server/src/routes/terminal_attach.rs:9-16` |
| 60초 capability TTL · SHA-256 digest만 저장 | `terminal_attach.rs:72`, `:470-500` · `server/Migrations/023_terminal_attach.sql:24-38` |
| 재검증 JOIN(만료 절만 완화) | `terminal_attach.rs:590-663` |
| controller = 소유자 전용 (PTY) | `routes/terminal_attach.rs:225-231` · `terminal_attach.rs:641` |
| controller = 소유자 전용 (display) | `routes/display_attach.rs:44-46`, `:283-287` |
| observer = `observation='open'` + 채널 멤버십 | `routes/terminal_attach.rs:232-247` · `terminal_attach.rs:643-660` |
| 관전자 브로드캐스트는 카운트만 | `routes/terminal_attach.rs:104-123` |
| 세션 목록 = 채널 멤버십 스코프, 소유자 무관, LIMIT 200 | `crates/momo-t3/src/lifecycle.rs:788-818` |
| 목록 투영(attach 가용·조작 중 시각) | `lifecycle.rs:528-530`, `:555-562`, `:747-782` |
| role 어휘 owner/admin/member/guest | `server/Migrations/001_init.sql:14` · `momo-auth/src/workspace_authorization.rs:27-45` |
| 웹 관전 클라에 stdin 인코더 부재(계약) | `clients/web/src/features/work/observerStream.ts:5-18` |
| 웹 display 조작 모듈(입력 데이터채널은 producer가 연다) | `clients/web/src/features/work/controlStream.ts:1-60` |
| `work_control` kind=input `{text}` 1‥32768 | `crates/momo-t3/src/work_control.rs:242-262` · `server/Migrations/020_work_control.sql:44-49` |
| work-controls는 agent bearer 전용 | `routes/work_controls.rs:170-178` |
| 제어창 = 에이전트 차단 + `owner_only` 강제 + 90초 리스 | `crates/momo-t3/src/display_control.rs:1-72`, `:397-425` |
| **갭 ①** PTY 바인딩 writer 부재 | `routes/work_sessions.rs:172-176`, `:383-387`, `:36-40` — `pty_id` writer 서버 전체 0건 |
| **갭 ②** observation PATCH 400 · 기본값 open · 웹은 이미 호출 | `routes/work_sessions.rs:399-402` · `server/Migrations/024_observer_attach.sql:9-12` · `ObserverTerminal.tsx:766` |
| **갭 ③** 감사 읽기 라우트 부재 | `docs/api/openapi.yaml:643-667`에만 존재, `lib.rs` 라우트 표에 없음 |
| Centrifugo 클라 publish 부재 | `infra/centrifugo.json` · `infra/prod/centrifugo.prod.json` |
| 휘발 평면 선례(PG 쿼리 0건) | `routes/ephemeral.rs:1-56` |
| 「인수」 = 계보 재개, 자격은 채널 멤버십 | `clients/web/src/features/work/TakeoverDisclosure.tsx:9-30` · `routes/work_sessions.rs:794-800` |
| ADR-0126 D1(관전) / D4(workspace 소유·operator 위임, v1 예약) | `docs/adr/0126-cowork-observation-surface.md` |
| ADR-0125 D10(직결·서버 중계 기각·방화벽 폴백 예고) | `docs/adr/0125-work-host-fabric.md:45-55` |
| ADR-0149(휘발 신호 평면·가드 5종·클라 publish 기각) | `docs/adr/0149-ephemeral-signals-typing.md` |
| herdr 실측(라이선스·감지 정확도·소켓 API·주입 사고) | `docs/planning/research/2026-08-06-herdr-spike.md` §1·§3.4·§4·§6·§7 |

## 부록 B — 웹 리서치 출처

tmate([tmate.io](https://tmate.io/), [CVE-2021-44512/44513](https://seclists.org/oss-sec/2021/q4/145), [tmate as a backdoor](https://dfir.ch/posts/tmate_as_a_backdoor/)) · tmux([#333](https://github.com/tmux/tmux/issues/333)) · GNU screen([Aclchg](https://www.gnu.org/software/screen/manual/html_node/Aclchg.html), multiuser/writelock) · VS Code Live Share([security](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security), [share terminal](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code)) · Warp([Agent Session Sharing](https://docs.warp.dev/knowledge-and-collaboration/session-sharing/agent-session-sharing)) · upterm([docs](https://upterm.dev/docs/upterm.html)) · gotty · [ttyd Auth-Proxy](https://github.com/tsl0922/ttyd/wiki/Auth-Proxy) · sshx([sshx.io](https://sshx.io/), [ekzhang/sshx](https://github.com/ekzhang/sshx)) · Zellij([multiplayer](https://zellij.dev/news/multiplayer-sessions/)) · Herdr([docs](https://herdr.dev/docs/agents/)) · Orca([stablyai/orca](https://github.com/stablyai/orca)) · 지연: [mosh 논문](https://mosh.org/mosh-paper-draft.pdf), [danluu 터미널 지연](https://danluu.com/term-latency/), [Are 100ms Fast Enough? (Springer)](https://link.springer.com/chapter/10.1007/978-3-319-58475-1_4), Aalto 타이핑 속도 연구
