# 스파이크 실측 — prime agent를 3번째 하네스로 (#1120)

> 근거: ADR-0154 D5-⑴ · `research/2026-08-06-prime-agent-ade-herdr.md` §① · 핸드오프 `2026-08-06-ade-stage1-spikes-packet.md` 워커 2
> 규율: 컨테이너 격리(비샌드박스) · **API 키 주입 없음** · 프로덕션 미접촉 · 재현 스크립트 `scripts/spikes/prime-agent/`
> 결론 한 줄: **RPC 표면은 전부 실동작했고, 로컬 스택 채널까지 실제로 폐곡선이 닫혔다**(prime-agent RPC → 어댑터 → REST → PG seq 1~7 → outbox broadcast 7/7 done). 붙이는 비용은 낮고, 막히는 지점은 자격증명·감사성·컨테이너 버그 3곳이며 전부 위치가 특정된다.

---

## 0. 무엇을 실제로 돌렸나 (한 번에 재현)

```
scripts/spikes/prime-agent/run_spike.sh build     # 이미지(핀: v0.7.0)
scripts/spikes/prime-agent/run_spike.sh all       # 7개 시나리오 전부
```

- 버전 핀: **v0.7.0**(2026-08-05 릴리스), tarball SHA-256 `88b657…4da0b` 빌드 시 검증. 출시 이틀차 프로젝트라 `latest`는 금지.
- 라이선스: **MIT** — GitHub API `license.spdx_id = "MIT"`, 리포 `LICENSE` 동일. 게이트 통과(2차 출처 확인 불필요 — herdr와 다른 상황).
- 격리: 전 시나리오 `docker run --network none`. prime-agent는 샌드박스가 아니므로 컨테이너 자체가 경계다. 호스트 직설치는 하지 않았다.
- 자격증명: **한 개도 주입하지 않았다.** 모델 자리는 컨테이너 루프백의 OpenAI 호환 목(`mock_provider.py`)이 채웠다. 목이 답하는 내용은 무의미하고, **측정 대상은 프로토콜과 수명주기**다.

| 산출물 | 무엇 |
|---|---|
| `scripts/spikes/prime-agent/Dockerfile` | v0.7.0 핀 + SHA 검증 + 커널 사전예열 |
| `scripts/spikes/prime-agent/mock_provider.py` | 자격증명 없는 루프백 프로바이더(+ 모든 LLM 요청 JSONL 기록) |
| `scripts/spikes/prime-agent/rpc_adapter.py` | RPC JSONL 클라이언트 + 델타 버퍼 + REST 싱크 + 승인카드 매핑 |
| `scripts/spikes/prime-agent/approval_gate.ts` | `extension_ui_request`를 발생시키는 최소 확장(ipython 셀 승인 게이트) |
| `scripts/spikes/prime-agent/container_entry.sh` · `run_spike.sh` | 컨테이너 내부 구동 · 호스트 재현 러너 |

---

## 1. 자격증명 벽 — **정확한 좌표**

패킷대로 "키 없이 갈 수 있는 데까지" 갔고, 벽은 딱 한 곳이었다. `prompt` 명령의 응답(정확한 원문):

```json
{"id":"...","type":"response","command":"prompt","success":false,
 "error":"No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  …/docs/providers.md\n  …/docs/models.md"}
```

읽어야 할 지점 3가지:

1. **벽은 프로세스 시작이 아니라 첫 `prompt`에 있다.** `--mode rpc` 기동·`get_state`·`get_available_models`(→ `{"models":[]}`)는 자격증명 0으로 전부 성공한다. 즉 어댑터 배선·핸드셰이크·수명주기는 키 없이 전부 개발·테스트 가능하다.
2. **`/login`은 TUI 대화형 명령이다.** RPC 명령 목록에 로그인이 없다(`rpc-types.ts` 커맨드 유니온 확인). 따라서 정식 통합 시 **워커 호스트에서 사람이 1회 `prime-agent` TUI로 `/login`** → `~/.prime/agent/auth.json`(0600) 생성 → 이후 RPC는 그 파일을 읽는다. ADR-0004(키는 워커 호스트 로컬에만)와 **모양이 맞는다** — 서버로 키가 흐르지 않는다.
3. **우회로가 존재한다(그리고 이번 스파이크가 그 길로 갔다).** `~/.prime/agent/models.json`의 커스텀 프로바이더는 임의 `baseUrl`을 받으므로, OpenAI 호환 엔드포인트만 있으면 자격증명 없이 전 표면을 돌릴 수 있다. → **CI/회귀 테스트를 키 없이 만들 수 있다**는 뜻이고, 정식 통합의 테스트 전략이 이미 확보됐다는 뜻이다.

> 성재 `/login` 대행 요청: **지금은 불필요.** 아래 2~6절 결과는 전부 키 없이 얻었다. 키가 필요해지는 시점은 "실제 모델 품질/토큰 비용/레이트리밋"을 재는 다음 단계이며, 그때는 **컨테이너 안에서 성재가 직접 1회 `/login`**(Claude Pro/Max 또는 ChatGPT)하는 형태를 제안한다. 키 문자열을 세션에 붙여넣는 형태는 필요 없다.

---

## 2. RPC 왕복 — 동작함

`prompt` → 델타 스트림 → `agent_end` 폐곡선이 성립. 관측 이벤트(텍스트 1턴):

```
response ×2 · agent_start · turn_start · message_start ×2 · message_update ×7 · message_end ×2 · turn_end · agent_end
```

프레이밍은 문서(`docs/rpc.md`)대로 **LF 전용**이다. 어댑터는 바이트로 읽고 `\n`으로만 자른다 — Node `readline`이 U+2028/2029에서도 잘라 프로토콜 위반이 된다는 경고가 문서에 명시돼 있고, 우리 쪽 구현체(TS 클라)를 쓸 때 그대로 걸릴 함정이다.

### 델타 버퍼링 실측 (단일 쓰기경로 비용)

`long` 시나리오(3,661자 응답, 7자 단위 델타):

| | 값 |
|---|---|
| `text_delta` 수 | **523** |
| 버퍼 플러시(=REST write) 수 | **17** |
| 압축비 | **30.8×** |
| 정책 | 224자 또는 0.8초, `text_end`에서 강제 플러시 |

델타당 1 REST write는 명백한 자멸이므로 버퍼는 선택이 아니다. 다만 **17개도 채널에는 많다** — 실물은 "메시지 1개를 편집"하는 모양이어야 하고, 그러려면 **메시지 편집 계약(부분 갱신)이 필요**하다. 현재 `sendMessage`만으로는 스트리밍 UX를 정직하게 못 만든다. → 정식 통합의 선결 과제 1.

---

## 3. `steer` — 동작함, 그리고 **증거가 있다**

목 프로바이더가 모든 LLM 요청 본문을 기록하므로 "끼어들기가 실제로 다음 LLM 호출에 들어갔는가"를 추측 아닌 관측으로 답할 수 있다.

시나리오: 1턴에 `ipython` 툴콜(6초 슬립) → 툴 실행 중 `{"type":"steer","message":"STEER: …"}` 주입.

목이 받은 **turn 3** 요청 메시지 배열:

```
system    | (base prompt)
user      | ["run a slow cell then report"]
assistant | (tool_calls: ipython)
tool      | (cell output)
assistant | [mock turn 2] …
user      | ["STEER: drop that and answer 42 instead"]   ← 끼어들기가 여기 들어갔다
```

문서가 말한 그대로 — "현재 어시스턴트 턴이 툴 실행을 마친 뒤, 다음 LLM 호출 전"에 **user 메시지로 주입**된다. 부수 관측:

- `session_action_update` 이벤트가 대기열(steering/followUps/queuedCount)을 실시간으로 흘려준다 → **"주입 대기 중" 배지를 UI에 정직하게 그릴 재료가 이미 있다.**
- 스트리밍 중 `prompt`를 `streamingBehavior` 없이 보내면 거절된다. 즉 호스트가 "지금 끼어들기냐 / 끝나고냐"를 **명시적으로 고르게 강제**한다 — 우리 UX에 그대로 옮길 만한 규율.
- `steer`/`follow_up` 모두 `one-at-a-time`이 기본, `all`로 바꿀 수 있다(`set_steering_mode`).

**이것이 이번 스파이크의 가장 큰 자산이다.** hermes/codex 경로에 없던 "실행 중 끼어들기"가 하네스 층에서 이미 계약으로 존재하고, 델타·대기열까지 이벤트로 나온다.

---

## 4. `extension_ui_request` → 승인 카드 — 동작함 (승인/거절 양쪽)

최소 확장 `approval_gate.ts`가 모든 `ipython` 툴콜을 `ctx.ui.select(["Approve","Reject"])`로 막는다. 어댑터는 이를 oort 메시지로 매핑했다.

**승인 경로**(`--ui-policy approve`) — relay 기록 그대로:

| # | `type` | 내용 |
|---|---|---|
| 1 | `tool_call` | `ipython` + args(코드 전문) |
| 2 | **`approval_request`** | title=코드 프리뷰, `props.options=["Approve","Reject"]`, `uiRequestId`, `dialog=true` |
| 3 | `system` | `notify` → "oort gate: cell approved" |
| 4 | `tool_result` | `spike: cell start / spike: cell done` |
| 5 | `text` | 어시스턴트 응답 |

**거절 경로**(`--ui-policy deny`) — red proof:

| # | `type` | 내용 |
|---|---|---|
| 3 | `system` | "oort gate: cell rejected" |
| 4 | `tool_result` | **"oort gate: rejected by host"** — `tool_execution_update` 0건, 셀은 **실행되지 않았다** |

즉 **거절이 실제로 실행을 막는다**(장식이 아니다). 매핑은 우리 스키마와 이미 맞는다 — `SendMessageRequest.type`에 `approval_request`·`tool_call`·`tool_result`가 이미 있다.

계약상 주의 3가지:

1. **dialog vs fire-and-forget를 구분해서 응답해야 한다.** `select/confirm/input/editor`는 `extension_ui_response`를 기다리며 **에이전트를 블록**하고, `notify/setStatus/setWidget/setTitle/set_editor_text`는 답하면 안 된다. 어댑터가 이 분기를 갖고 있다(`Adapter.handle_ui`).
2. **`timeout` 필드가 오면 하네스가 알아서 기본값으로 자동 해소한다.** 호스트가 타이머를 돌릴 필요는 없지만, **사람이 답하기 전에 자동 승인/취소가 일어날 수 있다**는 뜻이다 → 승인 카드에 남은 시간을 표시하고, 만료를 "무응답"으로 정직하게 기록해야 한다(ADE 리서치 §②의 expired 배지와 같은 문제).
3. **`tool_execution_start`가 승인 요청보다 먼저 나온다**(측정: 0.9ms 앞). 카드를 그리는 UI가 순진하게 이벤트 순서를 믿으면 **"실행 중"을 먼저 보여준 뒤 승인 카드가 뜬다.** 우리 쪽에서 tool_call 카드는 승인 결과가 나올 때까지 "대기" 상태로 잡아둬야 한다.

---

## 5. 컨테이너에서 깨진 것 — 2건 (둘 다 원인·회피책 확정)

### ⑴ IPython 커널이 첫 실행에서 인터넷을 요구한다

`--network none` 컨테이너의 첫 `ipython` 셀:

```
Failed to set up the Python kernel runtime. uv is required to set up the Python kernel…
First-time setup needs internet to install uv, Python, ipykernel, prime-agent-runtime, and default Python packages
```

`python3-venv`로 `ipykernel`을 미리 깔아둬도 소용없다 — 하네스는 **`uv`로 자기 전용 venv(`~/.prime/agent/kernel-venv`)를 만든다.** `prime-agent-runtime`은 **PyPI에 없고**(404) npm tarball 안에 동봉돼 `uv pip install --editable`로 설치된다.

빌드타임에 `PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 PRIME_AGENT_INSTALL_UV=1`로 깔면 venv는 생기지만 **번들 Python 스킬 8종은 첫 커널 기동 때 설치된다.** 측정:

| 조건 | 첫 셀까지 | 결과 |
|---|---|---|
| `--network none`, 예열 없음 | **80.3초** | 스킬 8종 전부 실패 — `agent_message`·`agent_observe`·`attach_image`·`compact`·`edit`·`goal`·`rlm_heartbeat`·`websearch` **사용 불가** |
| 네트워크 허용 | 3.5초 | 정상 |
| **빌드타임 셀 1회 예열 후 `--network none`** | **0.32초** | 정상, 경고 0 |
| 워밍 후 2번째 셀 | 0.1초(+슬립) | — |

→ **오프라인 컨테이너로 돌리려면 이미지에 커널을 예열해 구워야 한다.** 그러지 않으면 80초 지연에 더해 `agent_message`(RLM 서브에이전트 응답 채널)와 `goal`이 죽은 채로 돈다 — 조용한 기능 저하라 더 위험하다. Dockerfile에 예열 단계를 넣었고 수치는 위 표가 근거다.

### ⑵ 컨테이너에서 데몬 감독자가 `EXDEV`로 죽는다 (prime-agent 버그)

빌드타임 예열의 부산물로 `/tmp/prime-agent-0/`가 이미지 레이어에 구워지면, 런타임 첫 기동이 이렇게 죽는다:

```
Prime Agent daemon exited during startup (code 1).
supervisor: Daemon supervisor startup failed:
  Error: EXDEV: cross-device link not permitted,
  rename '/tmp/prime-agent-0/supervisor-owners/<uuid>.owner'
       -> '/tmp/prime-agent-0/supervisor-owners/<uuid>.owner.stale-<uuid>'
```

**RPC 클라이언트가 보는 것은 stdout EOF 하나뿐이다** — 에러 이벤트가 없다. 원인은 소유권 획득이 `renameSync`인데 overlayfs의 lower layer 파일을 rename하면 `EXDEV`가 나기 때문. 회피책은 빌드 끝에 `rm -rf /tmp/prime-agent-*`(Dockerfile에 반영). **업스트림 리포트 후보 1순위**(`renameSync` → copy+unlink 폴백).

읽어야 할 함의: **RPC 모드는 in-process가 아니라 데몬 백업이다.** 그래서 데몬 기동 실패가 곧 "조용한 EOF"가 된다. 어댑터는 **stderr를 반드시 캡처·기록해야 한다**(우리 어댑터가 그렇게 해서 원인을 잡았다).

---

## 5.5. 로컬 스택 실중계 — **폐곡선 성립**

목이 아니라 **실제 로컬 Rust 스택**(`infra/rust/docker-compose.rust.yml`, 프로젝트 `momo_spike_prime1120`, api :22930)에 어댑터를 붙였다. 프로덕션 미접촉, 종료 시 `down -v` + 볼륨 삭제 완료.

- 원리: 에이전트 principal(`agent_bearer`, scope `messages:write`)로 `POST /v1/workspaces/{ws}/channels/{ch}/messages`. **어댑터는 REST만 말한다** — Centrifugo 직결도, PG 직접 쓰기도 없다.
- 결과: **HTTP 201, seq는 전부 서버가 부여.** 승인 시나리오 1회로 채널에 5건이 그대로 앉았다(앞선 스모크 2건 포함 seq 1~7, 무결손):

| seq | type | body | props.harness / uiMethod |
|---|---|---|---|
| 2 | `text` | `[mock turn 1] echo: hello from the oort adapter` | prime-agent |
| 3 | `tool_call` | `ipython` | prime-agent |
| 4 | **`approval_request`** | `Run ipython cell? …` | prime-agent / **select** |
| 5 | `system` | `oort gate: cell approved` | prime-agent / notify |
| 6 | `tool_result` | `spike: cell start / spike: cell done` | prime-agent |
| 7 | `text` | `[mock turn 2] echo: run a cell` | prime-agent |

- **단일 쓰기경로가 실제로 탔다는 증거**: outbox에 `broadcast` 7건 전부 `done`(relay가 Centrifugo로 발행 완료), `push_candidate` 7건 `pending`(push worker 미기동 — 예상됨). 우회 경로를 탔다면 outbox 행이 생기지 않는다.
- 재현 시 주의 2가지: ⑴ 이번 실행은 **이미 있던 `momo-rust:lane-phone` 이미지**를 재사용했다(레포 HEAD에서 새로 빌드하지 않음 — 스파이크는 서버 코드를 재지 않으므로 의도적). ⑵ `infra/rust/rust-smoke.env.example`에 **`PROVIDER_LINK_MASTER_KEY`가 빠져 있어** 템플릿 그대로는 `docker compose config`부터 실패한다(agent-worker가 `${VAR:?}`로 요구). 이건 prime agent와 무관한 **레포 쪽 별건**이며, 템플릿 보수 티켓 후보다.
- 부수 발견: **에이전트 베어러로는 히스토리 GET이 403**(`agent bearer is not allowed for this route`). 스코프 allow-list가 닫혀 있어 `messages:write`만 열린다. 어댑터가 "자기가 보낸 것을 되읽어 확인"하는 설계는 불가능하므로, 전송 결과 확인은 **201 응답 본문의 `seq`/`id`**로만 해야 한다(어댑터가 그렇게 구현돼 있다).

## 6. 수명주기 — 데몬은 남는다

RPC 클라이언트가 stdin을 닫고 종료한 뒤:

```
socket                            pid  version  status   sessions  uptime
/tmp/prime-agent-0/daemon.sock *  27   0.7.0    current  0
```

세션은 0인데 **데몬은 살아 있다.** 컨테이너 안이면 컨테이너 수명에 묶이지만, 워커 호스트에 직접 깔면 **상주 프로세스가 쌓인다** — 우리가 이미 겪은 Docker 자원 누적/좀비 팀메이트 전례와 같은 계열의 문제다. 정리 경로는 `prime-agent shutdown` / `prime-agent doctor`(존재 확인함). 관련 명령: `list`·`attach`·`stop`·`send`·`schedule`·`status`.

부수 관측: 스케줄/하트비트를 걸면 **invocation-local RPC 세션이 resident 데몬 세션으로 승격**되어 stdin이 닫혀도 살아남는다(문서). "랩탑 닫아도 지속"(ADE 지향점)에 쓸 수 있는 원시 재료지만, 동시에 **우리 모르게 계속 도는 에이전트**를 만들 수 있는 손잡이다.

---

## 7. 정식 지원 판정 재료

### 붙이는 비용이 낮은 이유 (확인된 것)

- 프로토콜이 전부 문서화돼 있고 **실제로 문서대로 동작한다**(프레이밍·이벤트·응답 상관관계·steer 타이밍까지).
- 우리 메시지 스키마와 **매핑이 이미 존재**: `text`/`tool_call`/`tool_result`/`approval_request`/`system`.
- 단일 쓰기경로 위반 유혹이 없다 — RPC는 stdout JSONL일 뿐이고, Centrifugo에 직결할 경로 자체가 없다. **버퍼→REST만** 하면 계약이 지켜진다.
- **자격증명 없는 회귀 테스트가 가능**하다(§1-3). 하네스 통합 테스트를 CI에 넣을 때 키가 필요 없다.

### 정식 지원 전에 반드시 해결해야 하는 것 (선결 과제)

1. **메시지 편집 계약.** 스트리밍 응답 1개가 REST 17개 write = 채널 메시지 17개가 된다. "1 메시지 + 편집"이 없으면 스트리밍 UX가 성립하지 않는다. (`sendMessage`만으로는 부족 — 서버 축 과제)
2. **자기수정 감사성 — 현재 RPC로는 불가능하다.**
   > **정정 (2026-08-07, #1130 ②):** 아래 "이벤트로 알 방법이 없다"는 **과했다.** `refine_complete`가 같은 stdout으로 실제로 나온다(실측: 명령 송신~응답 창 = `["refine_complete","response"]`). 아래 결론이 `AgentEvent` 유니온만 보고 내려졌기 때문인데, 이 이벤트는 `AgentSessionEvent`라 그 유니온 밖이다. **다만** 그 이벤트는 `docs/rpc.md`·`rpc-types.d.ts` 어디에도 없고(문서/타입 드리프트), **커널 안 `rlm.harness` 직접 쓰기는 여전히 프로토콜 흔적 0건**이다(6런 × 37이벤트, `refine_complete` 0). 그래서 "감사는 디스크 관찰로만"이라는 실무 결론과 아래 정식 지원 조건은 그대로 유효하다. 전문: `2026-08-07-prime-refine-upstream-draft.md`. `AgentEvent` 유니온에 **하네스 변경 이벤트가 없다**(`agent_start/agent_end/turn_*/message_*/tool_execution_*` 전부). 반면 `refine`은 **RPC 커맨드로 존재한다**(`rpc-types.ts:55) — 그런데 `docs/rpc.md`에는 한 번도 나오지 않는다(커맨드 45개 중 유일). 문서/구현 드리프트 = 출시 이틀차 API 불안정의 실물 증거이고, 하필 그 하나가 **자기수정 커맨드**다. 게다가 하네스 상태는 커널 안 Python(`rlm.harness`)에서도 직접 쓸 수 있다. → **호스트가 "언제 무엇이 자기수정됐는지"를 이벤트로 알 방법이 없다.** 감사는 디스크 관찰(세션 JSONL + `harness/harness_state.json`)로만 가능하다. 정식 지원 조건: 어댑터가 harness 상태 파일을 해시·스냅샷해 변경을 채널 이벤트로 승격.
3. **전역 하네스 상태의 테넌시.** 세션-로컬 상태는 세션 아티팩트 아래지만, **전역 항목은 `~/.prime/agent/harness/`**에 산다. 한 컨테이너/호스트가 여러 워크스페이스를 서빙하면 **워크스페이스 간 학습 누출**이 된다. 정식 지원 조건: 워크스페이스당 `HOME` 분리(또는 컨테이너 1:1).
   > **실증 완료 (2026-08-07, #1130 ③):** 누출을 실제로 재현했다 — 격리 없이 한 컨테이너에서 워크스페이스 둘을 돌리면 B가 A의 전역 하네스 기억을 읽는다(`run_spike.sh tenancy-leak`). `HOME`+`TMPDIR` 분리로 막히고, 커널 venv를 `PRIME_AGENT_KERNEL_VENV`로 공유하면 §5-⑴의 80.3초 페널티도 안 낸다(실측 0.11~0.36초). `TMPDIR`까지 필요한 이유는 데몬 소켓 디렉터리가 HOME이 아니라 **uid** 기준이기 때문. 전문: `2026-08-07-prime-refine-upstream-draft.md` §3.
4. **컨테이너 이미지 예열 + `EXDEV` 회피가 운영 전제.** §5. 예열 없이 오프라인으로 돌리면 조용히 기능이 빠진다.
5. **승인 타임아웃 자동 해소**를 UI에서 정직하게 표기(§4-2), **툴 이벤트 선행 순서** 처리(§4-3).
6. **공급망**: 설치가 astral.sh에서 `uv`와 CPython 툴체인을 끌어온다. 우리 이미지에서 **빌드타임 1회**로 고정했지만, 정식 채택 시 미러/핀 정책이 필요하다.

### 판정 (제안)

**"3번째 provider로 승격할 가치 있음 — 단, 위 선결 1·2·3을 만족하는 어댑터가 전제."**
`steer`와 `extension_ui_request`는 hermes/codex에 없는 순증 자산이고 둘 다 실동작을 확인했다. 반대로 자기수정 감사성은 **현재 표면으로는 불가능**하며, 이건 성능 문제가 아니라 계약 결함이라 회피가 아니라 설계로 막아야 한다. 출시 이틀차 API라 v0.7.0 핀 + 상위 버전 승격 시 재실측을 규칙으로 둔다.

---

## 8. 하지 못한 것 (정직 기록)

- **모델 품질·비용·레이트리밋 미측정.** 목 프로바이더는 프로토콜만 재고 내용은 무의미하다. 이건 §1의 `/login` 이후 단계.
- **멱등 재시도 경로 미검증.** `RestSink`는 `clientMsgId`를 매 write마다 새로 만든다 — 즉 **재시도 시 같은 키를 재사용하는 로직이 없다.** 지금 상태로 네트워크 실패 후 재시도하면 중복 메시지가 된다. 실물 어댑터는 (flush 단위, 재시도 포함) 키를 고정해야 하고, 그 재시도 폐곡선은 이번에 재지 않았다.
- **실중계는 `text`/`extension-ui` 두 시나리오만.** `long`(17 write)·`steer`를 REST로 흘려 채널 UX가 실제로 어떻게 보이는지는 확인하지 않았다 — §2의 "메시지 편집 계약" 결론을 뒤집을 재료는 아니지만, 눈으로 본 적은 없다는 뜻이다.
- **Centrifugo 구독측 확인 안 함.** outbox `broadcast` 7건이 `done`인 것까지만 봤고, 실제 클라이언트가 그 이벤트를 받는 것은 이번 범위 밖.
- **`fork`/`clone`/`observe`/`send_message`(에이전트 간 메시징)·스케줄/하트비트 미검증.** 표면은 읽었고 커맨드는 존재하지만 이번 실행 범위 밖.
- **`refine` 실호출 안 함.** LLM 패스를 요구하고, 목으로 흉내내면 "자기수정이 실제로 무엇을 쓰는지"를 왜곡한다. 감사성 결론(§7-2)은 타입 유니온과 문서 기반이며, 실호출 확인은 키 확보 후 과제로 남긴다.
