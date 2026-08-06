# herdr 스파이크 실측 — #1121 (2026-08-06)

> 근거 패킷: `docs/planning/handoffs/2026-08-06-ade-stage1-spikes-packet.md` 워커 3 · 배경 `research/2026-08-06-prime-agent-ade-herdr.md` §③ · ADR-0154 D5-⑵.
> 성격: **실험**. 프로덕션 미접촉, 코드 재사용 0, 실행만. 실패·미검증 항목은 그대로 남긴다.

---

## 0. 한 줄 결론

**라이선스는 통과(Apache-2.0, v0.8.0 기준 — AGPL 주장은 2026-07-22 이전의 낡은 정보다).**
**하지만 herdr의 화면 감지는 우리 워커 좀비화의 해독제로 단독 채택할 수 없다** — 실측 blocked 재현율 **1/5**, 그리고 우리 실제 워커 형태인 `codex exec`(비대화형)는 32초 내내 **`idle`로 오분류**됐다. 쓸 수 있는 것은 감지기가 아니라 **상태 버스**다: 워커가 `pane report-agent`로 자기 상태를 밀어넣는 경로는 실측 성공했고, 소켓 구독→REST 릴레이 폐곡선도 실서버에서 `seq=1`로 성립했다.

---

## 1. 라이선스 실측 (1순위)

### 1.1 판정: **Apache-2.0** — 게이트 통과

| 확인 대상 | 실측값 |
| --- | --- |
| 리포 위치 | `ogulcancelik/herdr` → **`herdrdev/herdr`로 이전**(301 리디렉트, org 계정) |
| `LICENSE` 원문 | Apache License 2.0 표준 전문. 11,357 bytes, `sha256 c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`(정본 Apache-2.0 텍스트 해시와 일치 = 무개변) |
| `LICENSE` 내 AGPL/Affero 문자열 | **0건** |
| `Cargo.toml` | `license = "Apache-2.0"` |
| `README.md` | "Herdr is licensed under the Apache License 2.0" |
| GitHub 라이선스 감지 | `apache-2.0` |

### 1.2 2차 출처의 AGPL 주장은 "낡은 사실"이지 오보가 아니다

`LICENSE` 파일의 커밋 이력이 전환 시점을 정확히 찍어준다.

| 커밋 | 날짜 | 내용 |
| --- | --- | --- |
| `a57b9728` | 2026-03-22 | initial release — **AGPL-3.0** |
| `cfffe659` | 2026-05-26 | `docs: clarify dual licensing` — **AGPL-3.0-or-later + 상용 듀얼**(연락처 hey@herdr.dev) |
| `cd5ea1be` | **2026-07-22** | `chore: relicense herdr under apache-2.0` — LICENSE `+201 -671`, Cargo.toml·README·nix/package.nix 동시 수정 |

릴리스 경계: **v0.7.5(2026-07-21)까지 AGPL 계열, v0.8.0(2026-08-03)부터 Apache-2.0.**
→ **버전 핀이 곧 라이선스 핀이다.** `>= v0.8.0`을 벗어나 내려가면 AGPL 백본 금지 규율에 걸린다.

### 1.3 그럼에도 코드 재사용은 계속 금지(권고)

- 재라이선스가 **제3자 기여 이후**에 이뤄졌다(기여자 15+ — `dmmulroy`, `Pimpmuckl`, `reobin` 등이 2026-07-22 이전 기여). 리포에 CLA/DCO 문구는 확인되지 않았고, `CONTRIBUTING.md`는 "approved-contributor list" 승인제라 외부 기여 표면 자체가 좁다(=재라이선스 리스크는 낮지만 0은 아니다).
- 실무 결론: **실행은 무조건 안전. 코드/구조 차용은 하지 않는다**(패킷 규율 유지). 감지 룰 파일(`agent-detection/*.toml`)도 읽어 이해만 하고 복제하지 않았다.
- 우리가 실제로 원하는 건 코드가 아니라 **상태 어휘와 이벤트 계약**이며, 그건 라이선스 대상이 아니다.

---

## 2. 설치·핀·제거 절차 (실측)

```
버전         herdr 0.8.0 (2026-08-03 릴리스), socket protocol 19
바이너리     herdr-macos-aarch64
sha256       d53a9f93fccfdfcc55632927bf51002f5add0aa7990bcdf508ffbd84ac658178
크기         18,101,680 bytes · Mach-O 64-bit arm64 · 서명/공증 없음(Gatekeeper 차단 없이 실행됨)
```

설치(시스템 오염 최소 — brew·npm 미사용, 릴리스 바이너리 직다운):

```bash
curl -sSL -o ./bin/herdr \
  https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-macos-aarch64
chmod +x ./bin/herdr
./bin/herdr --version    # herdr 0.8.0
```

**실행 시 생기는 사용자 공간 흔적(실측 — 전부 신규 생성됨, 기존 파일 변경 0):**

| 경로 | 내용 | 크기 |
| --- | --- | --- |
| `~/.config/herdr/` | `herdr.sock`, `herdr-client.sock`, `herdr-server.log`, `session.json`, `.plugins.lock` | 264K |
| `~/.local/state/herdr/agent-detection/remote/*.toml` | **기동 시 원격에서 내려받는** 에이전트 감지 매니페스트 19종 | 84K |

- `HERDR_CONFIG_PATH`는 **config 파일 경로만** 바꾼다 — 소켓/로그는 여전히 `~/.config/herdr/`. 완전 격리는 `HERDR_SOCKET_PATH`까지 지정해야 한다(스파이크에서는 미사용).
- 데몬 자원: 5 페인 33분 운용에 **RSS 15.6 MB · CPU 0.7%**. 저렴하다.
- **제거(실측 완료, 잔여 0):**
  ```bash
  herdr workspace close <id>     # 페인 자식 프로세스까지 정리
  herdr server stop
  rm -rf ~/.config/herdr ~/.local/state/herdr
  rm -f ./bin/herdr
  ```
  종료 후 `pgrep herdr` 0건, 스파이크 페인이 띄운 codex/hermes 고아 프로세스 0건.
- **실행하지 않은 것**: `herdr integration install <agent>` — 사용자의 에이전트 설정(hooks)을 직접 수정하는 명령이라 의도적으로 회피했다. 감지는 이거 없이도 동작한다.
- 원격 매니페스트 자동 갱신은 **네트워크 의존이자 런타임 동작 변경 벡터**다. 사내 채택 시 `agent-detection` 로컬 override로 고정(pin)하는 절차가 별도로 필요하다.

---

## 3. 상태 감지 정확도 — 실측

### 3.1 측정 방법

- 헤드리스 서버(`herdr server`) 위에 워크스페이스 1개, 페인 4개.
- 각 케이스: 소켓 API를 **200ms 주기**로 `agent.get`(herdr 판정) + `pane.read --source detection`(herdr가 실제로 보는 화면 버퍼)을 동시 채집. 프롬프트 제출 시각을 t=0으로 잡고 전이 시각을 기록.
- 지상 진실(ground truth)은 화면 버퍼에 나타난 시각(예: `• Working (…)` 줄, 승인 프롬프트 문구)으로 정의.
- 스크립트: `scripts/spikes/herdr_probe.py`(재현 절차 포함).

### 3.2 결과표

| # | 상황 | 지상 진실 | herdr 판정 | 지연 | 판정 |
| --- | --- | --- | --- | --- | --- |
| 1 | codex TUI 컴포저 대기 | idle | `idle` | — | ✅ |
| 2 | codex TUI 작업 중(A1, `sleep 12`) | working @+0.429s | `working` @+0.632s | **+0.203s** | ✅ |
| 3 | codex TUI 작업 중(B1) | working | `working` @+0.623s | ~0.2s | ✅ |
| 4 | codex TUI 작업 중(B2) | working | `working` @+0.526s | ~0.2s | ✅ |
| 5 | **codex 도구 승인 대기**(B3, `curl` 네트워크) | blocked @+6.453s | `blocked` @+6.659s | **+0.206s** | ✅ |
| 6 | 승인 거절(esc) 후 복귀 | idle | `idle` | ~3s | ✅ |
| 7 | hermes TUI 대기 | idle | `idle` | — | ✅ |
| 8 | hermes TUI 작업 중(H1) | working | `working` @+0.753s | — | ✅ |
| 9 | hermes 응답 완료 | idle | `idle` @+3.208s | — | ✅ |
| 10 | 에이전트 없는 셸 페인 | (없음) | `unknown` | — | ✅ |
| 11 | codex **"Update available" 모달** | **blocked** | `idle` | — | ❌ |
| 12 | codex **"Do you trust this directory?" 모달** | **blocked** | `idle` | — | ❌ |
| 13 | codex **"Approaching rate limits / 모델 전환?" 모달**(A1) | **blocked** | `idle` | — | ❌ |
| 14 | 같은 모달 재현(B2, 독립 발생) | **blocked** | `idle` | — | ❌ |
| 15 | **`codex exec` 비대화형 32초 실행** | **working** | `idle` (전 구간) | — | ❌ |

**집계**
- 대화형 TUI만: 14건 중 9건 정확 → **64%**
- **blocked 재현율(recall) = 1/5 = 20%** · blocked 정밀도(precision) = 1/1 = 100%(오탐 0)
- working 재현율: 대화형 4/4 = 100%, **비대화형 0/1**
- 지연 시간은 맞출 때는 매우 빠르다 — **관측된 모든 정탐의 지연 ≤ 0.21s**(샘플 주기 1틱). 소켓 이벤트는 폴링이 아니라 푸시다.

### 3.3 왜 틀리는가 — 근본 원인 1개

`agent explain --verbose`가 근거를 전부 뱉어준다. 오분류 4건 전부 동일한 사유였다.

```
state: idle
rule: none
fallback_reason: default_known_agent_idle_fallback
```
또는 (모달이 떠 있는데도)
```
rule: osc_title_idle (region=osc_title priority=100)
evidence: "sandbox"
```

- 감지기는 **우선순위 규칙 매칭기**다(codex 매니페스트 `2026.07.18.1` 기준 7규칙). 상태별로 문자열/정규식을 OSC 타이틀·화면 하단 영역에 매칭한다.
- **정탐의 정체**: codex는 도구 승인이 필요할 때 터미널 타이틀을 `[ ! ] Action Required | sandbox`로 바꾼다. `osc_title_blocked`(priority 1100)가 이걸 잡는다 — 즉 **구조화된 신호**라 정확하고 빠르다.
- **오탐의 정체**: 업데이트·디렉터리 신뢰·레이트리밋 모달은 codex가 **타이틀을 바꾸지 않는다**. 어떤 blocked 규칙 문자열도 맞지 않고(예: 실제 화면은 `Press enter to confirm or esc to **go back**`인데 규칙은 `... esc to **cancel**`만 안다), 그러면 priority 100의 `osc_title_idle`이나 `default_known_agent_idle_fallback`이 이긴다.
- **설계상 치명적인 방향성**: herdr 자체 문서는 "`unknown`은 분류 실패이며 완료를 증명하지 않는다"고 쓰지만, 구현의 **미매칭 폴백은 `unknown`이 아니라 `idle`**이다. 관제 용도에서 안전한 폴백은 정확히 그 반대다 — 모르면 "괜찮음"이 아니라 "모름"이어야 한다.

### 3.4 이 오분류가 실제로 사고를 냈다 (스파이크 중 발생)

- herdr가 `agent_status: idle`, `interactive_ready: true`로 보고한 페인에 `agent prompt`를 보냈다.
- 실제 그 페인은 codex의 **"Update available" 모달**이었고, `agent prompt`가 보낸 텍스트+Enter가 기본 선택지 `1. Update now`를 확정시켰다.
- 결과: 사용자의 전역 codex CLI가 **0.144.1 → 0.146.1로 무단 업그레이드**됐다(§7 이탈 기록).
- 교훈이자 계약 요건: **`idle`을 "지시 보내도 안전"으로 신뢰하면 안 된다.** 지시 전에 화면(또는 우리 자신의 상태)을 반드시 재확인해야 한다. `agent prompt`는 원자적으로 텍스트+Enter를 보내므로 모달 위에서는 무조건 "기본 선택지 확정"이 된다.

### 3.5 `explain` 품질 — 이건 진짜 좋다

`agent explain --verbose`는 평가된 **모든 규칙**을 ✓/✗와 함께, 각 규칙이 본 화면 영역 원문 프리뷰까지 붙여 출력한다. 매니페스트 버전·원격 갱신 상태·로컬 override 여부도 함께. 오분류를 5분 만에 근본 원인까지 특정할 수 있었던 건 전적으로 이 도구 덕분이다.

- `agent explain --file <PATH> --agent <LABEL>`은 **오프라인 하네스**다. 캡처한 화면 스냅샷을 모델 호출 0회로 재분류할 수 있다 → 우리가 감지 룰을 평가·회귀 테스트하려면 이 형태를 그대로 흉내내면 된다(코드가 아니라 **구조**를 차용).
- 단, 파일 모드에는 OSC 타이틀 영역이 없다. codex의 정탐이 전부 타이틀 기반이므로 **파일 모드는 실제보다 비관적**이다. 스냅샷만으로 감지기를 평가하면 안 된다는 뜻이기도 하다.
- 한계: 푸시 보고된 에이전트(§5)에는 `explain`이 없다(`agent_explain_unavailable`) — "왜"는 보고자가 실어 보내야 한다.

---

## 4. 소켓 API 릴레이 스케치 (실서버 폐곡선 성립)

### 4.1 계약 실측

- 소켓: `~/.config/herdr/herdr.sock`(Unix stream), **줄단위 JSON**. 요청 `{"id","method","params"}` → 응답 `{"id","result"|"error"}`.
- `herdr api schema --json`이 **전체 JSON Schema(251KB, protocol 19)**를 뱉는다. request method 149종.
- 이벤트: `events.subscribe`로 스트림 개시. 구독 시 **현재 상태를 리플레이**해준다(`pane_created`·`pane_agent_detected`) → 릴레이 재시작 시 상태 복원이 공짜.
- **함정 1 — 페인별 구독**: `pane.agent_status_changed`는 `pane_id`가 **필수**다. "전체 관제"를 하려면 `pane.agent_detected`(전역)를 함께 구독해 새 페인을 발견할 때마다 구독을 추가해야 한다. 무필터 전역 상태 구독은 없다.
- **함정 2 — 이벤트 이름 표기 불일치**: 상태 이벤트만 점 표기(`pane.agent_status_changed`)이고 형제들은 밑줄(`pane_agent_detected`, `pane_created`). 0.8.0 실측이며 **둘 다 받도록 방어**해야 한다. 100일 된 1인 프로젝트의 API 안정성 리스크를 그대로 보여주는 증거.

### 4.2 프로토타입

`scripts/spikes/herdr_status_relay.py` — 소켓 구독 → 상태 전이 → oort 채널 REST POST.

지킨 불변식:
- **단일 쓰기경로**: `POST /v1/workspaces/{ws}/channels/{ch}/messages`만 사용. Centrifugo 직결·직접 SQL 없음. `seq` 권위는 PG.
- **멱등성**: `clientMsgId = uuid5(pane_id | state | ts)` — 재접속 리플레이가 중복 게시로 이어지지 않는다.
- **알림 위생**(리서치 §② "blocked만 푸시"): 기본 릴레이 대상은 `blocked` 단독. `working`/`idle`은 옵트인.
- **dwell 창**: 기본 800ms 안에 상태가 되돌아가면 게시하지 않는다(플래핑 억제).
- **본문에 `explain` 근거 동봉**: 사람이 "왜 막혔는지"를 채널에서 바로 본다.

### 4.3 실서버 검증 (로컬 스택 `momowebqa`, 127.0.0.1:28000)

1. 스파이크용 멤버·채널(`spike-1121-herdr`) 시드 → `POST /v1/auth/login`으로 accessToken 취득.
2. 릴레이 기동(`--states blocked`) → codex 페인에서 실제 승인 대기 유발.
3. 결과: `[relay] posted seq=1 state=blocked pane=w1:p4`

```
seq=1
🚧 codex — blocked
pane w1:p4 (workspace w1)

state: blocked
rule: osc_title_blocked (region=osc_title priority=1100)
evidence: "[ ! ] Action Required | sandbox"
```

4. 쓰기경로 무결성 확인: `outbox` 행 2건 — `broadcast`(status=done, processed) + `push_candidate`(pending, 이 스택엔 푸시 프로바이더 없음). **REST→PG→outbox→relay 폐곡선 성립.**
5. 멱등성 확인: 동일 `clientMsgId` 재전송 2회 → 매번 201·`seq=1`, 채널 메시지 총 **1건**(중복 없음). 저장된 본문도 원본 유지.

> **부수 발견(엔진 트랙 참고, 이 스파이크 범위 밖)**: 멱등 재전송의 **응답 본문이 저장된 원본이 아니라 방금 보낸 요청 본문을 되돌려준다**(`seq`는 원본 1). DB 행은 정상이라 데이터 문제는 아니지만, openapi가 "returns the original message"라고 서술한 것과 응답이 어긋난다. Swift 서버 실측이며, Rust 이식 시 이 동작은 따라가지 말 것.

---

## 5. `codex exec` 사각지대와 그 해독제 (핵심)

우리 fleet의 워커는 대화형 TUI가 아니라 **`codex exec`(비대화형)**다. 여기서 herdr의 감지는 정확히 반대로 틀린다.

- 32초 실행 내내 `agent_status = idle`. `agent list`에는 아예 나타나지 않는다.
- `explain --file`로 재확인: `rule: none / fallback_reason: default_known_agent_idle_fallback` — codex라는 건 알아보지만 어떤 규칙도 매칭되지 않아 idle로 떨어진다.
- 즉 **"워커가 일하는 중"과 "워커가 죽어서 멈춤"을 herdr는 구분하지 못한다.** 좀비 탐지 용도로는 최악의 실패 모드다.

### 해독제: 스니핑이 아니라 **푸시**

herdr에는 외부 소스가 상태를 직접 보고하는 경로가 있다(`pane.report_agent`). 실측 결과:

| 시도 | 결과 |
| --- | --- |
| `--agent codex`(정규 라벨)로 보고 | **무시됨**. `ok`는 반환되지만 상태 변화 0, 서버 로그에도 미기록 — 화면 감지기가 그 라벨의 권위를 갖고 즉시 회수한다 |
| `--agent oort-worker`(비정규 커스텀 라벨)로 보고 | **성립**. `pane.agent_status_changed`가 `agent="oort-worker"`로 발행되고 `agent list`·`pane get`에 반영 |

검증된 폐곡선:

```bash
herdr pane report-agent  <pane> --source oort --agent oort-worker --state working --seq N
herdr pane report-agent  <pane> --source oort --agent oort-worker --state blocked --seq N+1
herdr agent wait <pane> --until blocked --timeout 20000   # → 3.1초 만에 반환(이벤트 구동, 폴링 아님)
herdr pane release-agent <pane> --source oort --agent oort-worker --seq N+2   # → unknown 복귀
```

**운영상 주의**: 보고된 상태는 **프로세스가 죽어도 남는다**(TTL 없음 — `report-metadata`에만 `--ttl-ms`가 있다). 워커 래퍼가 exit trap으로 `release-agent`를 반드시 호출하지 않으면 "영원히 blocked인 유령"이 생긴다 — 좀비를 잡으려다 좀비를 만드는 구조다. 하트비트+TTL은 **우리 쪽에서** 설계해야 한다.

---

## 6. 판정 — 워커 좀비화 해독제로서

**조건부 채택(감지기로는 불채택).**

| 채택 | 근거 |
| --- | --- |
| ✅ **상태 어휘 3종 + "blocked만 푸시" 정책** | 리서치 §②의 업계 수렴과 일치하고, 실측에서도 blocked만이 사람을 부를 가치가 있는 신호였다. 우리 채널 상태 점·인박스 우선순위에 그대로 이식 가능(라이선스 무관 — 어휘는 저작 대상이 아니다) |
| ✅ **워커 자기보고(push) 모델** | `codex exec` 사각지대의 유일한 해법. herdr를 쓰든 안 쓰든 **우리 워커 래퍼가 상태를 내보내야 한다**는 결론은 동일하다 |
| ✅ **소켓→REST 릴레이 어댑터 형태** | 프로토타입이 실서버에서 성립. 단일 쓰기경로·멱등성·dwell 억제까지 계약 위반 없이 들어간다 |
| ✅ **`explain` 같은 "판정 근거 설명" UX** | 우리 승인 카드/상태 배지가 "왜 이 상태인지"를 못 말하면 같은 함정에 빠진다. 이건 herdr에서 배울 가장 값진 것 |
| ⚠️ **herdr 자체 = 운영자 콘솔로만** | 대화형 TUI 에이전트(사람이 직접 붙는 세션)에 한정. 재부팅 생존·원격 attach·시각적 페인 월은 실제 가치가 있다 |
| ❌ **herdr = 상태 감지기** | blocked 재현율 20%, 비대화형 워커 0%. 이걸 믿고 알림을 끄면 "조용한 좀비"가 그대로 통과한다 |
| ❌ **fleet 필수 의존** | 100일 1인 프로젝트, 이벤트 이름 표기조차 비일관, 감지 룰이 **원격에서 자동 갱신**된다(우리 관제 정확도가 남의 배포에 묶인다). 핀 필수이고, 핀해도 매니페스트는 네트워크에서 온다 |

**우리 좀비 전례에 대한 직접 답**: named 팀메이트가 조용히 죽는 문제는 herdr를 깐다고 해결되지 않는다 — herdr는 조용한 프로세스를 `idle`로 읽는다. 해결의 핵심은 **워커가 살아있음/막힘을 스스로 말하게 하는 것**이고, herdr는 그 신호를 사람이 볼 수 있게 그려주는 선택적 표시층이다.

### 다음 단계 후보 (착수 아님 — 결정 큐)

1. 워커 래퍼에 상태 방출 훅(working/blocked/idle + exit 시 release + 하트비트 TTL) — herdr 없이도 oort REST로 직행 가능하게 설계.
2. `blocked` = 멘션급 우선순위로 채널 목록/인박스에 반영(ADE 리서치 §② 차용분과 합류).
3. 감지 근거를 사람이 읽을 수 있게 남기는 규율(`explain` 상당) — 승인 카드/상태 배지 계약에 포함.
4. herdr 도입 여부는 **UXUI 트랙의 운영자 콘솔 필요성**이 확정된 뒤 재평가. 도입 시 `>= v0.8.0` 핀 + 감지 매니페스트 로컬 고정 절차 필수.

---

## 7. 이탈·부작용 기록 (정직 기록)

| # | 사건 | 상태 |
| --- | --- | --- |
| 1 | **사용자 전역 codex CLI가 0.144.1 → 0.146.1로 무단 업그레이드됨.** herdr가 `idle`로 오보한 페인이 실제로는 codex "Update available" 모달이었고, `agent prompt`의 텍스트+Enter가 기본 선택지 `1. Update now`를 확정시켰다(§3.4) | **미복구 — 성재 판단 대기.** 되돌리려면 `npm install -g @openai/codex@0.144.1` |
| 2 | 승인 프롬프트 유발 실험 중 `~/.herdr_spike_probe.txt` 생성(0 bytes) | 삭제 완료 |
| 3 | herdr가 원격 감지 매니페스트 19종을 `~/.local/state/herdr`에 자동 다운로드 | 디렉터리째 삭제 완료 |
| 4 | 로컬 QA 스택(`momowebqa`)에 스파이크 멤버·채널(`spike-1121-herdr`)·메시지 1건 시드 | **증거로 보존.** 시드 계정 비밀번호는 무작위 값으로 회전해 로그인 불가 처리. 완전 제거 SQL은 §8 |
| 5 | codex 주간 사용량 한도 5% 미만 경고를 실험 중 만남 — 프롬프트를 최소 토큰으로 제한했고, 모델 전환 제안은 전부 "현재 모델 유지"로 응답(사용자 설정 미변경) | 정보 |
| 6 | `herdr integration install` 계열 미실행(사용자 에이전트 설정을 수정하는 명령) | 의도적 미검증 |
| 7 | 대화형 codex의 `-a untrusted` 실험에서 `approvals_reviewer` 오버라이드가 필요했다(사용자 기본값 `guardian_subagent`가 자동 승인해버려 blocked가 재현되지 않음) — 세션 한정 `-c approvals_reviewer=user`로만 변경, 설정 파일 미수정 | 정보 |

---

## 8. 재현·정리 절차

재현(전체 스파이크):

```bash
# 1) 설치
mkdir -p bin && curl -sSL -o bin/herdr \
  https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-macos-aarch64
chmod +x bin/herdr
shasum -a 256 bin/herdr   # d53a9f93fccfdfcc55632927bf51002f5add0aa7990bcdf508ffbd84ac658178

# 2) 헤드리스 서버 + 페인
./bin/herdr server &
./bin/herdr workspace create --label herdr-spike
./bin/herdr agent start probe --kind codex --pane w1:p1
#   ※ agent start 직후 반드시 `pane read`로 실제 컴포저인지 확인할 것 —
#     idle 보고는 모달 위에서도 나온다(§3.4)

# 3) 감지 정확도 측정
python3 scripts/spikes/herdr_probe.py case-A probe w1:p1 \
  "Run the shell command: sleep 12, then reply DONE" 60

# 4) 릴레이 (로컬 스택만)
export MOMO_BASE_URL=http://127.0.0.1:28000 MOMO_WORKSPACE=... MOMO_CHANNEL=...
export MOMO_EMAIL=... MOMO_PASSWORD=...
python3 scripts/spikes/herdr_status_relay.py --states blocked

# 5) 제거
./bin/herdr workspace close w1 && ./bin/herdr server stop
rm -rf ~/.config/herdr ~/.local/state/herdr bin/herdr
```

로컬 QA 스택 시드까지 완전 제거하려면:

```sql
BEGIN;
SET LOCAL row_security = off;
DELETE FROM message    WHERE channel_id = '<CH>';
DELETE FROM membership WHERE channel_id = '<CH>';
DELETE FROM channel_seq WHERE channel_id = '<CH>';
DELETE FROM channel    WHERE id = '<CH>';
DELETE FROM human      WHERE email = 'herdr-spike-h1121@momo.local';
DELETE FROM member     WHERE handle = 'herdr-spike-h1121';
COMMIT;
```

---

## 9. 검증하지 못한 것 (정직 기록)

- **TUI 실사용**: 헤드리스 서버로만 구동했다. 실제 사람이 붙는 TUI(사이드바·상태 배지·키바인딩)의 UX 품질은 미평가. `idle` vs `done`의 차이(`done` = 미열람 배경 작업 완료)는 **포커스된 UI에서 탭을 봐야** 갈리는데, 헤드리스에는 포커스 개념이 없어 `done`을 한 번도 관측하지 못했다.
- **재부팅 생존**·**`--remote` SSH attach**·**live handoff 업데이트**: 미검증.
- **여러 워커 동시 6+ 페인**에서의 감지 지연/부하: 미검증(최대 4페인).
- **`herdr worktree` 계열**: 우리 fleet이 worktree 단위로 도는 만큼 중요하지만, 이번 범위 밖(명령 표면만 확인).
- **다른 에이전트 kind**(claude·gemini·droid 등 19종): codex·hermes 2종만 실측.
- **plugin/`popup` 표면**: 미검증.
- 감지 정확도 표본은 **케이스 15건**이다. 통계적 신뢰구간을 주장할 크기가 아니며, 특히 blocked 20%는 "codex 라이프사이클 모달"이라는 한 계열이 4건을 차지한 결과다. 그러나 그 계열이 **우리가 실제로 만나는 좀비 상황**이라는 점에서 대표성은 있다.
