# prime 자동 refine 실측 — `refine_complete`는 자동 경로에서도 같은 stdout으로 나오는가 (#1162 / #1189)

> 대상 핀: prime-agent **v0.7.0** (이미지 `oort-prime-adapter:0.7.0`, 보존)
> 규율: 자격증명 0(루프백 목 프로바이더) · `--network none` · 컨테이너 전부 `--rm` · 프로덕션 미접촉 · 레포 커밋 0
> 측정 리그(스크래치패드 전용, 레포에 없음):
> `scratchpad/measure/{mock_provider.py,auto_refine_probe.py,prod_entry_probe.py,run.sh}` · 산출 `scratchpad/out/*.json`
>
> #1162가 남긴 문장: *"같은 `_applyRefine` 경로라 나올 것으로 읽히나 **읽은 것이지 잰 것이 아니다**."* — 이 문서가 그 문장을 잰 것으로 바꾼다.

---

## 0. 판정 세 줄

1. **읽은 대로다 — 단, 조건부.** 자동 refine이 실제로 트리거되면 `refine_complete`는 **RPC 명령 유래와 완전히 같은 stdout JSONL**로 나오고, 어댑터의 `PrimeAdapter._on_refine_complete`가 그대로 잡아 채널에 `system` 한 줄을 만든다. **출고 코드 변경 0줄로 확인**(`prime.adapter.main` 그대로 호출 → FakeOort에 `momo.harnessRefine` 3건 착지).
2. **그런데 출고 기본값에서는 자동 refine이 **아예 일어나지 않는다**.** `adapter.py`의 `--no-session` 기본 ON이 `_autoRefineAllowedForSession()`을 항상 false로 만든다(로컬 하네스 dir 부재). 실측: `turnInterval=1`·`cooldown=0`으로 낮춰도 리뷰 게이트조차 안 돌고 이벤트 0. **즉 오늘의 프로덕션 배치에서 자동 refine은 "관찰이 안 되는" 게 아니라 "존재하지 않는다."**
3. **어댑터 관찰 경로가 자동 유래를 커버하느냐 = stdout은 YES / 파일 관찰은 NO / 라벨은 거짓.**
   - stdout: 커버함(측정 6/6런).
   - 파일 관찰(`HarnessObserver`): **못 잡음.** 자동 refine은 `scope: "local"` — 세션 아티팩트 밑 `session-artifacts/<id>/harness/harness_state.json`에 쓰는데, 옵저버는 전역 `~/.prime/agent/harness/harness_state.json`만 본다. stdout이 유일한 감시선이다.
   - 라벨: 어댑터가 모든 `refine_complete`를 `trigger: "command"`로 공지한다. 자동 유래도 "사람이 시켰다"로 채널에 적힌다. `TRIGGER_TURN_INTERVAL`/`TRIGGER_COMPACT` 상수는 정의만 되어 있고 아무도 안 쓴다.

---

## 1. 실측 표 (전 케이스)

한 컨테이너 = 한 케이스, 전부 `--network none --rm`. `turns`=어시스턴트 메시지 수(=목이 답한 에이전트 패스 수), `review`/`plan`=자동 refine의 두 LLM 패스 횟수(목 로그), `announce`=어댑터가 FakeOort에 쓴 refine 공지 수.

| case | prime argv | settings.json | turns | review | plan | `refine_complete` | announce | 하네스 파일 변경 |
|---|---|---|---|---|---|---|---|---|
| **A** `a-nosession-ti1` | `--no-session` | `turnInterval 1, cooldownMs 0` | 3 | **0** | 0 | **0** | 0 | 0 |
| **B** `b-session-ti1` | 세션 O | `turnInterval 1, cooldownMs 0` | 3 | 3 | 3 | **3** | 3 | 1 (local) |
| **C** `c-session-default25` | 세션 O | **없음(스톡 기본값)** | 26 | 1 | 1 | **1** | 1 | 1 (local) |
| **F** `f-cooldown-default` | 세션 O | `turnInterval 1` (쿨다운 기본 20분) | 3 | 1 | 1 | **1** | 1 | 1 (local) |
| **G** `g-compact` | 세션 O | 압축 임계 미조정 | 3 | 0 | 0 | 0 | 0 | 0 |
| **G2/G3** `g{2,3}-compact` | 세션 O | `compaction` 축소 | 2 | 1 | 1 | **0** | 0 | **1 (무음 기록)** |
| **G4** `g4-compact-live` | 세션 O | `compaction` 축소 + 2차 프롬프트 | 3 | 1 | 1 | **1** | 1 | 1 (local) |
| **H** `h-slowrefine` | 세션 O | `turnInterval 1, cooldownMs 0` + refine LLM 12초 지연 | 1 | 1 | 1 | **1** | 1 | 1 (local) |
| **I** `i-disabled` | 세션 O | `enabled: false` | 3 | **0** | 0 | **0** | 0 | 0 |

**출고 엔트리포인트 직접 호출**(`prime.adapter.main`, 리그가 아니라 프로덕션 코드):

| case | `OORT_PRIME_NO_SESSION` | 채널에 착지한 `momo.harnessRefine` |
|---|---|---|
| `prod-nosession` (출고 기본) | `1` | **0** |
| `prod-session` | `0` | **3** (seq 3·6·8, `type: system`) |

---

## 2. 트리거는 되는가 — 된다 (스톡 기본값 포함)

### 2.1 `turnInterval` 25는 실제로 발화한다 (case C)

`settings.json`을 **쓰지 않은** 스톡 상태에서 한 프롬프트 안에 도구 호출을 26회 체인 → 어시스턴트 메시지 26개. 25번째 `turn_end` 직후에 리뷰 1회 + 플랜 1회 + `refine_complete` 1회. 25 미만 구간에서는 0.

```
turn_end ×25 → t=46.536 refine_complete → t=46.715 agent_end
settingsWritten: null      # 기본값 그대로
passes: {agent_turn: 26, auto_refine_review: 1, refine_plan: 1}
```

> 카운터의 단위가 **프롬프트가 아니라 어시스턴트 메시지**라는 게 실무적으로 중요하다(`agent-session.js:2452` `_assistantTurnsSinceAutoRefine++`). 도구를 여러 번 부르는 긴 한 턴이면 프롬프트 1회로도 25에 닿는다 — case C가 정확히 그 형상이다.

### 2.2 설정으로 낮출 수 있다 (실측)

`<agentDir>/settings.json`(= `$HOME/.prime/agent/settings.json`, `FileSettingsStorage`)에

```json
{"autoRefine": {"turnInterval": 1, "cooldownMs": 0}}
```

를 쓰면 매 턴 발화(case B: 3턴 → 3회). 반증 대조군으로 `{"autoRefine": {"enabled": false}}`는 같은 조건에서 0회(case I) — 즉 이 레버는 양방향으로 실재하고, case B의 3회는 우연이 아니다.

### 2.3 쿨다운 20분은 벽이지만 우회 가능하고, **첫 발화는 막지 않는다**

- 코드: `underCooldown = _lastAutoRefineReviewAt > 0 && now - _lastAutoRefineReviewAt < cooldownMs`. 세션 시작 시 `_lastAutoRefineReviewAt = 0`이므로 **첫 자동 refine은 쿨다운과 무관**하다.
- 실측: `turnInterval 1` + 쿨다운 기본(20분) → 3턴에 **1회만**(case F). 같은 조건에서 `cooldownMs: 0` → **3회**(case B). 벽의 존재와 우회 수단이 같은 자로 확인된다.
- 우회는 설정 파일 한 줄이면 되고, 컨테이너 안 `$HOME` 밑이라 자격증명·네트워크 없이 가능하다.

### 2.4 `compact` 트리거 — 발화는 하지만 **경로에 무음 구멍이 있다**

- 압축이 실제로 일어나야 한다. 컨텍스트 여유가 있으면 `compact` 명령은 *"Session is too short to compact"*로 **success:false** 되고 refine도 없다(case G).
- 압축이 성사되면 `_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction)`이 걸린다. 이번 형상에서는 `willContinueAfterCompaction`이 참이라 **즉시 실행되지 않고 `_compactAutoRefinePending`로 유예**됐다.
- 유예된 채로 세션이 끝나면(= 어댑터가 stdin을 닫으면) **disposal 드레인**이 그때서야 refine을 돌린다. 실측 G2/G3 2런 모두: 리뷰·플랜 패스가 **정확히 stdin close 시점**에 발생하고, 하네스 파일은 갱신되는데 **`refine_complete`는 stdout에 0건**(close 이후 큐 드레인에도 0건, `__eof__`만).
  → **커널 경로와 같은 무음 사례가 하나 더 있다.** 다만 성격이 다르다: 커널 경로는 "쓰는 주체가 이벤트를 안 낸다", 이건 "이벤트를 낼 무렵 RPC가 이미 내려갔다".
- 유예분이 **세션이 살아 있는 동안** 드레인되면(압축 뒤 프롬프트 한 번 더) 정상적으로 stdout에 나오고 어댑터가 잡는다(case G4: `refine_complete` 1, 공지 1).

---

## 3. 이벤트는 같은 stdout 경로로 나오는가 — YES

### 3.1 소스 (읽은 것)

`refine_complete`의 emit 지점은 **단 하나**다 — `dist/core/agent-session.js:6272`, `_applyRefine()` 안:

```js
this._emit({ type: "refine_complete", result });     // 6272 — 유일 emit
await this._extensionRunner.emit({ type: "refine_complete", ... }); // 6279 — 확장용, 별개
```

명령 경로(`refine` RPC) → `refine()` → `_applyRefine()`, 자동 경로 → `_maybeAutoRefine()` → `_runApprovedRefine()` → `refine()` → `_applyRefine()`. 합류점이 같으니 이벤트 형상도 같다.

### 3.2 측정 (잰 것)

자동 유래 `refine_complete`의 원문 레코드(case B, 첫 건):

```json
{"type":"refine_complete","result":{
  "id":"refine_20260808160824140",
  "summary":"...", "rationale":"...", "expectedOutcome":"...",
  "appliedEdits":[{"action":"create","kind":"memory","id":"oort-refine-probe",
                   "title":"...","content":"...","after":{...},"applied":true}],
  "harnessStatePath":"/work/homes/<ws>/.prime/agent/session-artifacts/<sid>/harness/harness_state.json",
  "scope":"local"}}
```

명령 유래(#1130 ② 측정)와 **필드 구성이 동일**하다. 그리고 결정적으로:

> **`refine_complete` 레코드에는 트리거를 구별할 필드가 없다.** `reason`도 `trigger`도 없다. 수신 측은 "이게 자동인지 명령인지"를 이벤트만 보고는 알 수 없다.

### 3.3 `agent_end`보다 먼저 오는가 — 온다 (프로덕션 펌프의 사활 문제)

`adapter.py`의 `adapter.pump(deadline)`는 **`agent_end`에서 반환**한다. 자동 refine이 `agent_end` 뒤에 나오면 출고 어댑터는 못 본다. 그래서 따로 쟀다.

| 케이스 | refine LLM 지연 | `refine_complete` | `agent_end` | 순서 |
|---|---|---|---|---|
| C | 0초 | t=46.536 | t=46.715 | **먼저** (179 ms) |
| B(3건) | 0초 | 2.485 / 4.285 / 4.498 | 4.504 | **먼저** |
| **H** | **12초**(리뷰 6 + 플랜 6) | t=13.544 | t=13.556 | **먼저** (12 ms) |

case H가 핵심이다. 목이 빨라서 우연히 앞선 게 아니라, **하네스가 자동 refine이 끝날 때까지 `agent_end`를 잡고 있다**. 실 프로바이더의 수 초 지연에서도 순서가 뒤집히지 않는다는 뜻이고, 따라서 `agent_end`에서 멈추는 현재 펌프로도 자동 refine을 놓치지 않는다. (예외는 §2.4의 유예-압축 경로뿐이고, 그건 애초에 stdout에 안 나온다.)

### 3.4 출고 엔트리포인트로 확인

리그가 아니라 `prime.adapter.main()`을 그대로 호출한 런(`prod-session`)에서 FakeOort가 받은 것:

```
seq 3  system  "김인턴이 자기 작업 방식을 갱신했습니다 (항목 1건)"  momo.harnessRefine{refinementId: refine_20260808162528489, ...}
seq 6  system  같은 형태
seq 8  system  같은 형태
```

FakeOort는 서버 계약을 강하게 모사한다(파생 `clientMsgId` 일치·`scope: workspace`·`deny_unknown_fields`). **전부 통과했다** — 즉 자동 유래 공지는 오늘의 서버 계약에도 그대로 들어맞는다.

---

## 4. 그래서 무엇이 문제인가 (실측이 새로 연 항목)

### 4.1 [Blocker급] 출고 기본값에서 자동 refine이 아예 없다

`adapters/prime/adapter.py:143`:

```python
parser.add_argument("--no-session", action="store_true", default=env_flag("NO_SESSION", True))
```

`--no-session` → 세션 아티팩트 dir 없음 → `_localHarnessStateDir()` undefined → `_autoRefineAllowedForSession()` **false**. 그 한 줄이 다음을 전부 끈다:

- 자동 refine(turn_interval·compact) 전부
- 에이전트가 스스로 부르는 `refine.run` / `refine.status` 커널 핸들러 (`agent-session.js:6967`)
- 모델에게 보이는 `refine` 스킬 자체 (`agent-session.js:6928`)

실측 A: `turnInterval=1`·`cooldown=0`에서도 리뷰 패스 0회. **판정은 "자동 유래를 어댑터가 못 잡는다"가 아니라 "오늘 배치에는 자동 유래가 없다"이다.** 운영 전 체크리스트 항목으로서 이게 진짜 결론이다. 세션을 켜기로 결정하면(ADR 사안) 그 순간부터 §3의 경로가 살아나고, 그때는 아래 4.2~4.4가 곧바로 실린다.

### 4.2 [High] 자동 유래가 채널에 `trigger: "command"`로 적힌다

`prime_adapter.py:342`:

```python
announcement = self.announcer.announce_refine_complete(result, trigger=TRIGGER_COMMAND)
```

이벤트에 트리거 필드가 없으니(§3.2) 어댑터가 상수를 박아 넣는데, 그 상수가 `command`다. 실측: case C(스톡 25턴 자동)·case G4(압축 자동)·case B(3건 전부) 공지가 모두 `"trigger": "command"`. `refine.py`가 `turn_interval`/`compact`를 정의해 둔 취지("어떤 계기였는지를 정직하게 적는다")가 코드에서 무력화돼 있다.

구별 가능한 재료는 있다: 명령 경로는 우리가 `refine` 명령을 보낸 뒤 `response(command="refine")`가 따라온다. **어댑터가 보낸 refine 명령이 in-flight인 동안 온 `refine_complete`만 `command`, 나머지는 자동**으로 라벨하면 상태 하나로 정확해진다(압축 여부까지 가르려면 `compaction_end` 직후 창을 하나 더 봐야 한다).

### 4.3 [High] 자동 refine은 `HarnessObserver`가 보는 파일에 쓰지 않는다

- 자동 경로는 `options.global`이 없으므로 `requestedScope = "local"` → `session-artifacts/<sessionId>/harness/harness_state.json`.
- `HarnessObserver`가 감시하는 경로는 `default_harness_state_path()` = `$HOME/.prime/agent/harness/harness_state.json`(전역).
- 실측 전 런에서 `observerWatchPath`는 존재조차 하지 않았고(`exists: false`), `check_harness_drift()`는 `observed_drift`를 한 건도 만들지 않았다.

→ **자동 유래는 이중화가 없다.** stdout이 유일선이고, stdout이 죽는 경로(§2.4 유예-압축)에서는 감사 흔적이 0이 된다. 옵저버가 세션-로컬 디렉터리까지 보게 하는 것이 이 구멍의 정직한 메움이다(파일이 세션마다 새로 생기므로 "경로 하나 감시"가 아니라 "디렉터리 스캔"이 된다 — 설계 결정 필요).

### 4.4 [Medium] `applied: false` 편집도 "항목 1건"으로 공지된다

case B의 2·3번째 refinement은 같은 엔트리를 다시 만들려다 `appliedEdits[0].applied = false`로 끝났는데, 채널에는 세 건 모두 *"항목 1건"*으로 나갔다. `refine.py::_wire_edits`가 `applied`를 보지 않기 때문이다. 업스트림 확장 emit은 같은 자리에서 `appliedEdits.filter(e => e.applied).length`로 세고 있다(`agent-session.js:6283`) — 우리 쪽만 안 거른다.

### 4.5 [Note] 목 프로바이더는 자동 경로를 **구조적으로 거부**하고 있었다

기존 목(`tests/mock_provider.py`)은 `<current_harness_state>` 마커 하나로 refine 패스를 식별해 `RefinementProposal`을 돌려준다. 그런데 자동 경로는 LLM 패스가 **둘**이고(리뷰 게이트 `reviewAutoRefine` → 플랜 `planRefinement`) 둘 다 그 마커를 갖는다. 리뷰에 제안서를 돌려주면 `parseAutoRefineReview`는 예외 없이 `shouldRefine=false`로 읽는다 → **모든 자동 refine이 조용히 거부된다.** 이번 측정은 리뷰 패스를 `<trigger>` / *"automatic /refine review gate"* 로 갈라 승인 JSON을 돌려주도록 목을 고쳐야 비로소 가능해졌다.

→ **어댑터 테스트를 자동 경로까지 넓히려면 목의 이 분기가 선행 조건이다.** 지금 목으로는 자동 refine 회귀 테스트를 쓸 수 없다(항상 초록으로 보이지만 실제로는 아무것도 돌지 않는다).

---

## 5. 재현 절차

```bash
SP=<scratchpad>
# 1) 리그 준비 — 이미지는 기보존된 oort-prime-adapter:0.7.0 그대로 사용(빌드 불필요)
#    scratchpad/measure/mock_provider.py 가 tests/mock_provider.py 위에 read-only 마운트된다.

# 2) 스톡 기본값에서 turnInterval 25 발화 (헤드라인)
MOCK_CHAIN_TOOLS=25 $SP/measure/run.sh c-session-default25 \
  --no-session off --timeout 400 --post-agent-end 45

# 3) 출고 기본값(=--no-session)에서 0건인 것 확인
MOCK_CHAIN_TOOLS=2 $SP/measure/run.sh a-nosession-ti1 \
  --turn-interval 1 --cooldown-ms 0 --no-session on --timeout 200 --post-agent-end 40

# 4) 쿨다운 벽 / 우회
MOCK_CHAIN_TOOLS=2 $SP/measure/run.sh f-cooldown-default --turn-interval 1 --no-session off   # → 1건
MOCK_CHAIN_TOOLS=2 $SP/measure/run.sh b-session-ti1 --turn-interval 1 --cooldown-ms 0 --no-session off  # → 3건

# 5) agent_end 경합 (refine LLM 12초 지연)
MOCK_CHAIN_TOOLS=0 MOCK_REFINE_DELAY=6 $SP/measure/run.sh h-slowrefine \
  --turn-interval 1 --cooldown-ms 0 --no-session off --post-agent-end 40

# 6) compact 경로 (무음 / 라이브)
MOCK_SCENARIO=long MOCK_CHAIN_TOOLS=0 MEASURE_CONTEXT_WINDOW=4000 \
MEASURE_EXTRA_SETTINGS='{"compaction":{"keepRecentTokens":300,"reserveTokens":200}}' \
  $SP/measure/run.sh g3-compact-long --no-session off --send-compact --post-agent-end 150   # → stdout 0, 파일 1
MOCK_SCENARIO=long MOCK_CHAIN_TOOLS=0 MEASURE_CONTEXT_WINDOW=4000 \
MEASURE_EXTRA_SETTINGS='{"compaction":{"keepRecentTokens":300,"reserveTokens":200}}' \
  $SP/measure/run.sh g4-compact-live --no-session off --send-compact --second-prompt        # → stdout 1, 공지 1

# 7) 출고 엔트리포인트 그대로
#    prod_entry_probe.py 를 OORT_PRIME_NO_SESSION=0/1 로 두 번
```

전 케이스 `--network none`, `--rm`, 자격증명 0.

---

## 6. 하지 못한 것 (정직 기록)

- **실 프로바이더로는 안 쟀다.** 리뷰 게이트가 실제로 `shouldRefine`을 어떻게 판단하는지는 이 측정의 범위 밖이다(목이 항상 승인). 잰 것은 "게이트가 통과하면 이벤트가 어디로 나오는가"다.
- **`willContinueAfterCompaction`이 왜 참이었는지는 끝까지 안 파고들었다.** §2.4의 유예가 이 형상에 특유한 것인지 압축 경로의 일반형인지는 미확정 — 다만 "유예되면 disposal까지 무음"이라는 사실 자체는 2/2런 재현.
- **다중 워크스페이스/동시성 미측정.** 한 컨테이너 한 세션만 돌렸다.
- **`rollbackId` 경로 여전히 미검증**(#1130 때와 동일).
- **레포 파일 0줄 수정, 커밋 0.** 리그는 전부 스크래치패드에 있고, `mock_provider.py` 수정본은 컨테이너에 read-only 마운트로만 올라갔다.

## 7. 잔여물

- 컨테이너: 0 (전 케이스 `--rm`; `docker ps -a --filter ancestor=oort-prime-adapter:0.7.0` → 없음).
- 이미지: `oort-prime-adapter:0.7.0` **보존**(요청대로).
- 네임드 볼륨 생성 0(바인드 마운트만 사용). 소스 추출용 임시 컨테이너 1개는 `docker rm`으로 회수.
