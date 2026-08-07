# prime-agent 자기수정(refine) 감사 — 업스트림 이슈 **초안** + 우리 쪽 채널 이벤트 설계 스케치 (#1130 ②·③)

> 기준: prime-agent **v0.7.0** 핀(tarball SHA-256 `88b657…4da0b`) · 재현 `scripts/spikes/prime-agent/run_spike.sh {refine,tenancy-leak,tenancy-home,tenancy}`
> 선행 정본: `docs/planning/research/2026-08-06-prime-agent-spike.md`(#1120) · #1130 · #1152(stream rev edit 계약, merged)
> 규율: 자격증명 0(루프백 목 프로바이더) · `--network none` · 프로덕션 미접촉 · 서버/코어/클라 0줄
>
> **⚠ 이 문서의 §1은 업스트림에 제출하지 않았고, 제출하지 않는다.** 외부 발신은 성재 승인 사안이다. 초안은 승인 시 그대로 붙여넣을 수 있는 상태로만 둔다.

---

## 0. 결론 세 줄

1. **#1130 ②의 전제가 부분적으로 틀렸다.** 자기수정 이벤트는 **존재한다** — `refine_complete`가 RPC stdout으로 나온다. 다만 문서·타입 어디에도 없어서, 계약을 읽고 클라이언트를 짜는 사람은 그 존재를 알 수 없다. 결함의 성격이 "이벤트 없음"에서 **"문서/타입 드리프트"**로 바뀐다.
2. **진짜로 안 보이는 경로는 따로 있다.** 커널 안 `rlm.harness`가 같은 `harness_state.json`을 직접 쓰면 프로토콜에 흔적이 **0건**이다(실측 6/6런, 각 37이벤트 중 `refine_complete` 0). 이건 문서 문제가 아니라 설계 구멍이고, 어댑터가 파일 해시로 메워야 한다.
3. **③ HOME 격리는 실증됐고 비용이 0이다.** 격리 없음 → 워크스페이스 B가 A의 전역 하네스 기억을 읽는다(red proof MATCH). `HOME`+`TMPDIR` 분리 → 안 읽힌다. 커널 venv를 공유해서 오프라인 80.3초 페널티도 안 낸다(측정 0.11~0.36초).

---

## 1. 업스트림 이슈 **초안** (제출 안 함)

> 붙여넣기 단위로 영문. 리포: `PrimeIntellect-ai/prime-agent`. 라벨 후보: `docs`, `rpc`.
> **제출 전 확인**: 성재 승인 · v0.7.x 최신에서 재확인(출시 이틀차 API라 이미 고쳐졌을 수 있다).

```markdown
### `refine` command and `refine_complete` / `refine_failed` events are missing from docs/rpc.md and from the RPC types (v0.7.0)

**Summary**

RPC mode can trigger and observe continual-harness refinement, but neither the
command nor its events appear in `docs/rpc.md`, and the events do not appear in
`dist/modes/rpc/rpc-types.d.ts` at all. A client written against the published
contract cannot discover that self-modification is reachable, is enabled by
default, or is observable.

**Reproduction (v0.7.0, no credentials needed)**

1. Install the pinned tarball:
   `npm i -g prime-agent-0.7.0.tgz`

2. The command union has 45 members; exactly one is absent from the RPC docs:

   ```sh
   P=$(npm root -g)/prime-agent
   sed -n '18,193p' $P/dist/modes/rpc/rpc-types.d.ts \
     | grep -oE 'type: "[a-z_]+"' | sed 's/type: //;s/"//g' | sort -u > /tmp/cmds
   wc -l < /tmp/cmds                                  # 45
   while read c; do grep -qw -- "$c" $P/docs/rpc.md || echo "MISSING: $c"; done < /tmp/cmds
   # MISSING: refine
   ```

3. Run `prime-agent --mode rpc --model <any>` and send:

   ```json
   {"id":"r-1","type":"refine","global":true}
   ```

   stdout emits, in this order:

   ```
   {"type":"refine_complete","result":{...RefinementResult...}}
   {"id":"r-1","type":"response","command":"refine","success":true,"data":{...}}
   ```

4. Neither event name appears anywhere in the shipped docs:

   ```sh
   grep -rn 'refine_complete\|refine_failed' $P/docs/   # no matches
   ```

   `docs/rpc.md` §"Event Types" lists 16 events and includes the sibling
   subsystem's `compaction_start` / `compaction_end`, but not the refinement
   pair.

5. Neither event name appears in the RPC type surface:

   ```sh
   grep -n 'refine' $P/dist/modes/rpc/rpc-types.d.ts
   # 14: import type { RefinementResult } ...
   # 76:   type: "refine";          (RpcCommand)
   # 309:  command: "refine";       (RpcResponse)
   ```

   The events are declared on `AgentSessionEvent`
   (`dist/core/agent-session.d.ts:153,157`) and emitted at
   `dist/core/agent-session.js:6272`, but a TypeScript client that types stdout
   as `RpcResponse | AgentEvent | RpcExtensionUIRequest` has no name for them.

**Why this matters more than a typical doc gap**

* Refinement is **on by default without any host command**:
  `getAutoRefineSettings()` (`dist/core/settings-manager.js:538`) returns
  `enabled: settings.autoRefine?.enabled ?? true`, `turnInterval` default `25`,
  `compact ?? true`, `cooldownMs` default `20 * 60_000`. A long RPC session
  mutates its own harness state on a timer. A host that does not know
  `refine_complete` exists will never log that.
* Refinement mutates state the host may be legally responsible for auditing:
  `RefinementResult.appliedEdits[].before/after` is the only structured record
  of what changed, and `scope: "global"` writes outside the session, into
  `~/.prime/agent/harness/harness_state.json`.

**Second, separate gap: kernel-side writes emit nothing**

`rlm.harness` (`dist/prime-agent-runtime/src/rlm/harness.py`) writes the *same*
`harness_state.json`; the harness itself hands the kernel the path via
`RLM_GLOBAL_HARNESS_STATE_DIR` (`dist/core/agent-session.js:7070`). A model that
runs

```python
from rlm.harness import get_harness_state
get_harness_state(global_=True).create_memory("t", "c", id="x", global_=True)
```

changes global harness state with **no protocol output at all**. Measured across
6 runs: 37 events each, `refine_complete` = 0, `refine_failed` = 0. Host-side
auditing currently requires watching the file.

**What we'd expect**

1. Document `refine` in `docs/rpc.md` §Commands and `refine_complete` /
   `refine_failed` in §Event Types (they are already implemented; this is a
   documentation fix).
2. Add both events to the RPC types so clients can name them.
3. Consider a harness-mutation event that also covers kernel-side writes — e.g.
   emit on `HarnessState.save()` regardless of who called it — so "the harness
   changed" is one observable fact rather than two paths with different
   visibility.

**Environment**

prime-agent v0.7.0, `node:22-bookworm-slim`, `--network none`, custom
OpenAI-compatible provider (loopback mock, no credentials).
```

### 1.1 우리가 실제로 잰 것 (초안의 근거)

| 주장 | 실측 | 출처 |
|---|---|---|
| `RpcCommand` 45개 중 `refine`만 미문서 | 45개 추출, `docs/rpc.md` 단어 매치 실패 = `refine` 1건 | `rpc-types.d.ts:18-193` |
| `AgentEvent`는 하네스와 무관 | 10개 멤버, `harness`/`refine` 문자열 0 | `@earendil-works/pi-agent-core/dist/types.d.ts:357` |
| `refine`은 실제로 동작한다 | `success:true`, `appliedEdits` 1건 `applied:true`, `scope:"global"` | `run_spike.sh refine` |
| 하네스 파일이 실제로 바뀐다 | 없음 → 1000바이트, `entryIds:["oort-refine-probe"]`, `refinementIds:["refine_20260807041452415"]` | 같은 런 `refineAudit.harnessAfter` |
| **이벤트가 있다** | 명령 송신~응답 사이 창에 `["refine_complete","response"]` | 같은 런 `refineAudit.recordsInWindow` |
| 그 이벤트는 문서에 없다 | `grep -rn refine_complete docs/` → 0 | 컨테이너 실행 |
| 그 이벤트는 RPC 타입에도 없다 | `rpc-types.d.ts`의 `refine` 언급 3곳 전부 command/response | 위 표 1행과 같은 파일 |
| 커널 경로는 무음이다 | 6런 × 37이벤트, `refine_complete` 0 / `refine_failed` 0 | `tenancy-{off,home,full}/transcript-text-ws-{a,b}.json` |
| 자동 refine 기본 ON | `enabled ?? true`, turnInterval 25, compact true, cooldown 20분 | `settings-manager.js:538-546` |

> 목 프로바이더가 `<current_harness_state>` 마커를 보고 유효한 `RefinementProposal`을 돌려주도록 했다(`mock_provider.py`). 그래서 이 측정은 **파싱 실패 경로가 아니라 성공 경로**다. 부수 실측: refine의 LLM 패스는 `completeSimple`인데도 **스트리밍으로 온다** — 비스트리밍만 처리하면 못 잡는다.

### 1.2 선행 정본(#1120 문서) 정정

`2026-08-06-prime-agent-spike.md` §7-2의 *"호스트가 '언제 무엇이 자기수정됐는지'를 이벤트로 알 방법이 없다"* 는 **과했다.** 그 문장은 `AgentEvent` 유니온만 보고 내린 결론이고, `refine_complete`는 `AgentSessionEvent`라 그 유니온 밖에 있다. 같은 stdout으로 나온다. 해당 절에 정정 포인터를 넣었다. 정정 후의 정확한 결함은 두 개다: **⑴ 문서/타입 드리프트, ⑵ 커널 경로 무음.** ⑵만 남아도 "감사는 디스크 관찰로만 가능"이라는 §7-2의 실무 결론 자체는 유지된다 — 어댑터는 어차피 파일을 봐야 한다.

---

## 2. 우리 쪽 채널 이벤트 설계 **스케치** (제안 수준 — 구현 금지)

> 목적: ADR 승격 여부를 판단할 재료. 아래 어떤 것도 이번 PR에서 구현하지 않았다.

### 2.1 먼저, 이건 `message.edited`가 아니다 (#1152와의 관계)

#1152는 "답이 도착하는 것은 그 답의 수정이 아니다"라는 이유로 스트림 조각에서 `state='edited'`·`edited_at`을 떼어냈다. 같은 자를 자기수정에 대면 결론은 **정반대 방향**이다.

| | #1152 stream 조각 | 하네스 refine |
|---|---|---|
| 무엇이 바뀌나 | **한 메시지의 본문** | **에이전트의 이후 행동** — 어떤 메시지도 안 바뀐다 |
| 빈도 | 턴당 17회(실측) | `turnInterval` 25턴 · `cooldownMs` 20분 게이트 |
| seq | **소비 안 함** — 17개가 미읽음 17개로 보이면 안 되니까 | **소비해야 함** — 되짚어 갈 수 있는 자리가 있어야 감사다 |
| 프레임 | 기존 `message.edited` 재사용 | 기존 `message.new`(type=`system`) |
| 되감기 방어 | `momo.stream.rev` 단조 가드 | 불필요 — 각 refinement은 독립 사건 |

→ **`stream {rev, final}` 경로를 타면 안 된다.** 탔다가는 `momo.stream.rev`의 단조 가드에 refinement 리비전이 섞여 이후 조각을 stale로 얼린다. 두 계약은 겹치는 게 아니라 **직교**한다. 겹치는 지점은 딱 하나: 둘 다 "에이전트가 쓴 것"이라 `edited_at` 비대칭(사람 수정만 도장)을 공유한다.

### 2.2 형상 제안

기존 라우트 `POST /v1/workspaces/{ws}/channels/{ch}/messages`, 새 타입 0개.

```json
{
  "clientMsgId": "<refinement id>",
  "type": "system",
  "body": "김인턴이 자기 작업 방식을 갱신했습니다 — 기억 1건 추가",
  "props": {
    "harness": "prime-agent",
    "momo.harnessRefine": {
      "refinementId": "refine_20260807041452415",
      "trigger": "command | turn_interval | compact | observed-drift",
      "scope": "workspace",
      "edits": [{ "action": "create", "kind": "memory", "id": "oort-refine-probe" }],
      "summary": "…"
    }
  }
}
```

| 규칙 | 왜 |
|---|---|
| `clientMsgId` = **refinement id** | `RefinementResult.id`가 이미 하네스가 부여한 안정 키다. 스파이크 §8이 지적한 "재시도 시 같은 키를 재사용하는 로직이 없다"가 여기선 공짜로 해결된다 |
| `type: "system"`, seq 소비 | 드물고 결과가 크다. 타임라인에 자리가 있어야 "언제부터 이 에이전트가 달라졌나"를 사람이 스크롤로 답할 수 있다 |
| 본문은 사람 문장, 근거는 props | 승인 카드(`approval_request`)와 같은 규율 |
| `edits`는 **id·종류만**, 내용 미포함 | 하네스 내용은 대화 전문을 반영할 수 있다. 채널에 그대로 부으면 요약본 유출이다. 전문은 워커 호스트 파일에 남고 채널에는 "무엇이 몇 건" |
| `scope`는 항상 `workspace` | ③ 참조. 어댑터는 워크스페이스별 HOME으로 돌므로 하네스의 "global"은 우리 기준 workspace다. **하네스의 global scope를 그대로 노출하면 거짓말이 된다** |
| `trigger: "observed-drift"` | 커널 경로(§1) 전용. "우리가 파일이 바뀐 걸 봤다"는 정직한 진술이고, "에이전트가 X를 결정했다"고 주장하지 않는다 |

### 2.3 어댑터가 져야 할 일 (설계 부채 명시)

1. `refine_complete` 구독 — 문서에 없는 이벤트를 이름으로 알고 있어야 한다. v0.7.x 승격 시 **이 이름이 살아 있는지 재실측**이 규칙이 된다(핀 규율의 연장).
2. `harness_state.json` 해시를 `turn_end`마다 비교. 변경 O + 직전 `refine_complete` X → `observed-drift`. §1의 커널 무음을 메우는 유일한 수단이고, 업스트림이 3번 항목을 고치면 지울 수 있는 코드다.
3. **워크스페이스 HOME 격리 없이는 켜면 안 된다.** 격리 전에는 "이 워크스페이스가 스스로를 갱신했다"는 메시지가 사실이 아니다 — 옆 워크스페이스가 갱신했을 수 있다(§3 red proof). **③이 ②의 선행이다.**

### 2.4 ADR로 올릴지 판단할 지점 (여기서 결정 안 함)

- **기본 노출 여부.** 자기수정을 채널 멤버 전원에게 기본 공개할 것인가, 워크스페이스 옵트인인가. 에이전트를 1급 멤버로 두는 제품에서 "동료가 스스로를 바꿨다"는 사실은 UX 원칙(P1~P15) 쪽 판단이 필요하다.
- **`system` 타입 재사용 vs 전용 타입.** 지금 형상은 새 타입 0을 지키지만, `system`이 관문 알림(`oort gate: cell approved`)과 자기수정 공지를 같은 통에 담는다. 필터링 수요가 생기면 갈라야 한다.
- **롤백 노출.** `refine`은 `rollbackId`로 되감을 수 있다(`RefineOptions`). 되감기를 채널에 어떻게 보일지는 이 스케치 범위 밖.

---

## 3. #1130 ③ — 워크스페이스별 HOME 격리 (실증 완료)

### 3.1 누출이 어디서 나는가 (경로 실측)

| 층 | 해석 | 출처 |
|---|---|---|
| Node | `getAgentDir()` = `$PRIME_AGENT_CODING_AGENT_DIR` ?? `join(homedir(), ".prime/agent")` | `dist/config.js:403` |
| Node | 전역 하네스 = 위 + `/harness` | `dist/core/refinement/refinement.js:145` |
| Python(커널) | 동일 규칙 — 같은 env, 같은 fallback | `dist/prime-agent-runtime/src/rlm/harness.py:37-43` |
| 커널 주입 | `RLM_GLOBAL_HARNESS_STATE_DIR = getGlobalHarnessStateDir()` | `dist/core/agent-session.js:7070` |
| **데몬** | 소켓 디렉터리 = `join(tmpdir(), "prime-agent-" + getuid())` — **HOME이 아니라 uid 기준** | `dist/modes/daemon/daemon-socket.js:195-197` |

`HOME`을 고른 이유(≠ `PRIME_AGENT_CODING_AGENT_DIR`): agent dir만 옮기면 `sessions`·`auth.json`·`models.json`·`~/.prime/config.json`(`prime-inference-auth.js:16`)·셸 dotfile이 그대로 공유된다. 커널은 이 uid로 임의 코드를 돌린다 — env 하나로 하네스만 가리는 건 격리가 아니라 정리다.

### 3.2 실측 (컨테이너 1개 안에서 워크스페이스 2개 — #1130 ③이 말한 그 형상)

`ws-a`가 커널 셀에서 전역 하네스 기억을 쓰고, `ws-b`가 **쓰기 전에** 보이는 목록을 읽는다.

| 모드 | ws-b가 쓰기 전 본 것 | 같은 state 파일? | ws별 `daemon-workers/` 레지스트리 | 판정 |
|---|---|---|---|---|
| `off` (격리 없음) | **`["oort-tenancy-ws-a"]`** | **예** | — | **누출 재현 — red proof** |
| `home` (HOME만) | `[]` | 아니오 | ws-a만 생김(공유 `/tmp/prime-agent-0`을 ws-a가 소유) | 하네스는 격리 |
| `full` (HOME+TMPDIR) | `[]` | 아니오 | **ws-a·ws-b 각각** | **채택** |

- red proof 명령: `scripts/spikes/prime-agent/run_spike.sh tenancy-leak` → `verdict: MATCH`, `aMarkerVisibleToB: true`, `sharedStateFile: true`.
- 단정이 헛돌지 않는다는 확인(inversion): `tenancy_probe.sh full expect-leak` → `verdict: MISMATCH`, **exit 1**.
- `home`으로도 하네스는 갈렸다. 그런데 데몬 감독자가 uid 기준이라 두 워크스페이스가 `/tmp/prime-agent-0` 하나에서 만나고, ws-b는 자기 워커 레지스트리를 못 갖는다. 이번 런에서 내용 유출은 없었지만(`grep -rl ws-a /work/homes/ws-b` → 0건, 반대도 0건) **제어면이 공동 소유인 상태**다. 그래서 `TMPDIR`까지 가르는 `full`을 기본으로 둔다.

### 3.3 비용: 0 (커널 예열을 잃지 않는다)

HOME을 옮기면 예열된 `~/.prime/agent/kernel-venv`도 같이 사라진다 — 그대로 두면 스파이크 §5-⑴의 **오프라인 80.3초 + 번들 스킬 8종 사망**이 재발한다. 해결: venv는 테넌트 데이터가 아니라 패키지 설치이므로 `PRIME_AGENT_KERNEL_VENV`(`bootstrap.js:291`)로 이미지 사본을 공유하고, 벤더된 `bin/`(rg·fd)은 심링크한다.

| | 실측 |
|---|---|
| 격리 상태 셀 지연 | **0.11 ~ 0.36초**(6런) — 예열 유지 확인 |
| `rlm.harness` import | 6/6 성공 — 번들 스킬 venv 온전 |
| 이벤트 수 | 6런 모두 37 — 격리로 인한 프로토콜 변화 0 |
| 기존 시나리오 회귀 | `text` 7 message_update / `long` 17 flush / `steer` `session_action_update` 4 / `approve`·`reject` uiRequests 2 — #1120 문서 수치 그대로 |

### 3.4 정식 통합 시 계약 (제안)

1. 워크스페이스당 `HOME` + `TMPDIR`. 컨테이너 1:1이면 자동 충족이지만, **1 컨테이너 N 워크스페이스가 가능한 배치라면 이 두 env가 필수**다.
2. `kernel-venv`·`bin`만 공유. 공유 대상은 "빌드 산출물"로 한정하고 `auth.json`·`sessions`·`harness`는 절대 공유 금지.
3. 데몬은 `prime-agent shutdown --force`로 회수. `--force` 없으면 비대화형에서 *"Shutdown requires confirmation in an interactive terminal"* 로 조용히 실패하고 데몬이 남는다(실측). 스파이크 §6의 상주 데몬 문제에 붙는 실무 각주다.

---

## 4. 하지 못한 것 (정직 기록)

- **`refine`의 실제 LLM 판단은 재지 않았다.** 목이 돌려준 제안은 우리가 쓴 것이다. 잰 것은 "명령이 닿는가 / 파일이 바뀌는가 / 프로토콜이 뭐라 말하는가"이지 "무엇을 자기수정하는가"가 아니다.
- **자동 refine(turnInterval 25 / compact)을 실제로 트리거하지 않았다.** 기본값 ON은 소스 실측이지만, 25턴을 목으로 돌려 `refine_complete`가 실제로 나오는지는 확인 안 했다. 같은 `_applyRefine` 경로라 나올 것으로 읽히나 **읽은 것이지 잰 것이 아니다.**
- **`rollbackId` 경로 미검증.**
- **채널 이벤트 설계는 서버에 한 줄도 닿지 않았다.** §2는 제안이고, `momo.harnessRefine` props 키는 존재하지 않는다.
- **업스트림 제출 안 함**(설계상). v0.7.x 상위 버전에서 이미 고쳐졌는지도 확인 안 했다 — 제출 승인 시 첫 단계로 둔다.
- **멀티 uid 격리 미검증.** `full`은 uid를 공유한 채 TMPDIR만 가른다. 커널이 임의 코드를 돌리는 이상 진짜 경계는 uid/컨테이너이고, 이번 실측은 "같은 uid에서 상태가 안 섞이는가"까지만 답한다.
