# goal RN-A1 — 에이전트 운영 표면 (폰에서 에이전트를 부린다)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-A1-agent-ops`(브랜치 `feat/RN-A1-agent-ops`, 생성됨).

발단: 성재 — *"아직 메신저 정도 수준에도 못 미치는 UXUI야. **우리 핵심기능을 담는 부분도 미흡해.**"*
진단 정본 `docs/planning/2026-08-03-roadmap-diagnosis.md`(**먼저 읽어라**)의 **A안**이 이 배치다.

## 0. 오케스트레이터 실측 (여기서 출발 — 다시 재지 마라)

`server-rust`는 **58 라우트**. 그중 **이미 있는 것**:

```
GET/PUT  /v1/workspaces/{ws}/agents/{agent}/profile
PUT      /v1/workspaces/{ws}/agents/{agent}/pause
GET      /v1/workspaces/{ws}/agents/{agent}/allowed-models
POST     /v1/workspaces/{ws}/agents
GET      /v1/workspaces/{ws}/roster            ← 에이전트도 member다
GET/POST /v1/workspaces/{ws}/work-sessions
GET      /v1/workspaces/{ws}/work-sessions/{session}
GET/POST /v1/workspaces/{ws}/channels/{ch}/agent-runs
```

모바일 `src/features/` = `conversation · inbox · search · sidebar · workspace` **다섯**.
웹 = **스물셋**(`agentHub · agents · work · routing …`).

**즉 폰에서는 에이전트를 재우거나 깨울 수도, 지금 무슨 일을 하는지 볼 수도 없다.** 메시지에 답이 오는 것만 본다. 그건 "에이전트 네이티브 메신저"가 아니라 **봇이 있는 채팅**이고, ADR-0101이 봇 래핑을 거부한 그 자리로 되돌아간 것이다. **이 배치가 그걸 되돌린다.**

## 1. 규율
`.env`·자격증명 금지 · **서버 코드·`schema_v0.sql` 수정 금지**(서버는 이미 준다) · **docker 금지** · **실서버 접속 금지** · `clients/iOS`·`clients/mobile-spike` 수정 금지 · `expo prebuild`·EAS·`android/` 금지 · 커밋은 새 커밋만 · **PR 후 STOP**.

## 2. 이 배치의 진짜 일 — **웹에 갇힌 판단 로직을 꺼내라**

판단 로직이 **웹 안에만** 있어서 모바일이 못 쓴다. 실측한 순수 모듈:

| 파일 | 줄 | 순수성 |
|---|---|---|
| `clients/web/src/features/agentHub/model.ts` | 153 | 순수 |
| `clients/web/src/features/agentHub/channelPlacement.ts` | 121 | 순수 |
| `clients/web/src/features/agents/agentRail.ts` | 384 | 순수 |
| `clients/web/src/features/agents/agentWorkingSignal.ts` | — | **React 참조 있음** |
| `clients/web/src/features/work/observerStream.ts` | — | **React/DOM 참조 있음** |

- **순수 3개는 `packages/momo-core`로 올려라.** 웹은 거기서 import하게 바꾸고 **동작·테스트 수가 줄면 안 된다**(`gate:purity` 통과 필수 — momo-core는 React/DOM 금지).
- **불순 2개는 이 배치에서 건드리지 마라.** 필요한 판단만 새로 순수하게 쓰고, 왜 통째로 못 올리는지 PR에 한 줄.
- API 호출도 마찬가지다. 에이전트 프로필·pause·work-session 조회를 **`packages/momo-core/src/lib/api.ts` 규약대로** 추가해라(기존 함수들의 에러 처리·타입·상태코드→한국어 문장 규약을 그대로 따라라). **모바일에서 fetch를 직접 부르지 마라.**

## 3. 만들 것 — 「에이전트」 표면

### 3-1. 목록
워크스페이스의 에이전트들. 각 행이 **지금 상태를 말해야 한다**: 깨어 있나/재워졌나(pause), 지금 일하는 중인가, 어느 채널에 있나.
- 에이전트는 **member다**(하드 불변식). `roster`에서 분기 없이 온다 — **에이전트 전용 목록 API를 발명하지 마라.**
- 사람과 에이전트를 어떻게 구분해 보여줄지는 네 판단이되, **`clients/web`이 이미 쓰는 표식과 어긋나면 안 된다.** 두 클라가 같은 것을 다르게 부르면 그게 결함이다.

### 3-2. 프로필
이름·모델·설명 등 서버가 주는 것. `allowed-models`가 있으니 **고를 수 있는 모델을 실제로 보여줘라**(하드코딩 금지).

### 3-3. **재우기 / 깨우기 (이 배치의 심장)**
`PUT .../pause`. 폰에서 *"김인턴 지금 자고 있네, 깨워야겠다"*가 되어야 한다.
- **낙관적 갱신 + 실패 시 되돌리기**. 실패는 **한국어 문장**으로 말한다(상태코드 노출 금지 — 기존 규약).
- **되돌릴 수 없는 인상을 주지 마라**: 재우면 무엇이 멈추는지(진행 중 run은 어떻게 되는지) 화면이 말해야 한다. **서버 실동작을 코드로 확인하고 그대로 적어라** — 추측해서 문구를 쓰지 마라. 확인이 안 되면 단정하는 문구를 쓰지 말고 PR에 남겨라.

### 3-4. 지금 무슨 일을 하는가 (관전 최소분)
그 에이전트의 **작업 세션**을 목록으로. 진단 B안의 최소 절단면이다.
- **호스트 등급을 반드시 표시해라.** ADR-0137 D5 명시: `type=app`은 **기기를 끄면 죽고** `workd`/`cloud`는 **계속 돈다**. 사용자의 질문은 *"지금 이거 꺼도 되나"*이고 화면이 거기에 답해야 한다.
- **터미널 raw PTY는 D5가 강등했다** — 폰에서 80컬럼을 읽는 문제다. 열지 마라. "데스크톱에서 열기"로 넘겨라.
- 세션 상세·타입드 행 아코디언은 **다음 배치**다. 여기서는 목록·상태·호스트 등급까지.

## 4. 경계 결정 — **세 번째 탭이 이 배치에서 생긴다**

`src/nav/state.ts`가 스스로 적어놨다: 목적지가 둘이라 `react-navigation`을 안 들였고, *"그건 네 번째 화면을 추가하는 사람의 결정"*이라고.

- **이 배치는 `react-navigation`을 도입하지 마라.** 기존 리듀서를 확장해라. 네이티브 모듈 2개 추가는 **ADR-0137 D1 의존성 방침과 얽힌 ADR 사안**이다.
- 도입이 꼭 필요하다고 판단되면 **하지 말고 PR에 근거를 적어 넘겨라**(RN-U2와 같은 규칙).
- 탭이 셋이 되면 **탭바 레이블·너비·접근성**이 흔들린다. `tabLabel`·`TABS`가 정본이니 거기서만 늘려라.
- **엣지 스와이프 뒤로가기(RN-U2)가 새 화면에서도 살아 있어야 한다.** 탭 전환에는 안 걸린다는 성질도 유지.

## 5. 지키던 성질 (하나도 되돌리지 마라)
입력 상태 **동기**(한글) · **`inverted` 금지** · 남이 말하면 위치 안 뺏김(≤2px)/내가 말하면 따라감 · 키보드 올라오면 첫 탭은 닫기·내려가면 스레드 · 키보드 닫기 3경로 · 롱프레스 250ms가 스크롤과 안 싸움 · **좌측 엣지 스와이프 뒤로가기** · 스레드 안에서 「답글 N개」 없음 · 상태코드→한국어 문장 · **오프라인 시작이 로그인 화면이 아님**(`restoreSession`의 `unreachable` 규약 — 절대 깨지 마라).

## 6. 검증
`npx tsc --noEmit` · `npx jest` · `gate:project-shape` · **`gate:session`** · `verify_ios_signing.sh` · `verify_push_kit_inheritance.sh` · **iOS 시뮬레이터 빌드 성공(앱+NSE)**.
웹을 고쳤으므로(로직 이관) **웹 게이트 전부**: `typecheck`·`lint`·`test`·`build`·**`capture:design`** — 그리고 **테스트 수가 줄면 안 된다**.
`packages/momo-core`: `test` + **`gate:purity`**.

**성재가 폰으로 볼 것이다.** 화면이 서면 무엇을 보게 되는지 PR에 적어라.

## 7. PR에 적을 것
`feat/RN-A1-agent-ops` → `track/engine`. 본문에:
- momo-core로 올린 것과 **웹이 안 변했다는 근거**(테스트 수·게이트 수치).
- 에이전트/사람 표식이 웹과 일치한다는 근거.
- **pause의 실동작**(진행 중 run이 어떻게 되는지)을 **어디서 확인했는지**.
- 호스트 등급 표시가 D5 문장과 어떻게 대응하는지.
- 탭 3개 판단 · `react-navigation` 판단.
- 게이트 수치 · 이탈.

**PR 후 STOP.**
