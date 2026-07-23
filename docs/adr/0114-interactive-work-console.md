# ADR-0114: Interactive Work Console — 에이전트가 조종하는 앱 내 터미널 (Warp/Conductor형)

- Status: **Accepted** (2026-07-19, 성재 — v2 권고안 D1~D8 전체 승인 "ㄱㄱ". 파생 MOMO-483부터 순차 발급, Host Fabric은 ADR-0125로)
- 관련: ADR-0102(실행 경로 — interactive 반쪽), ADR-0111(BYOA — 실행 호스트 모델의 원형), ADR-0004·MOMO-234(provider credential 비유입 하드 경계), MOMO-375(Control+backtick 표면 승계), docs/planning/SUPERAPP_ENGINE_GAP_2026-07-19.md
- 참고 지형: **Warp**(에이전트가 명령 실행, 사람이 관찰·개입), **Conductor**(다중 Claude Code 세션 병렬 관리), Orca. 공통: 터미널은 에이전트의 작업 공간이고 사람은 감독자다.

## Context

1. **제품 모델(성재)**: ①터미널이 있고 사람이 claude/codex/opencode를 직접 쳐서 쓸 수 있다 ②그러나 기본 흐름은 **사람이 채팅에서 요청 → 에이전트가 필요에 따라 CLI 세션을 스폰·조종·작업 → 결과 제공** ③세션 내용은 채팅으로 흘러들어오고(진행·산출물), 채팅 입력이 세션으로 흘러들어간다(양방향).
2. **하드 경계 불변**: momo 서버는 process·provider credential을 보관/proxy하지 않는다. CLI 도구와 자격증명(~/.codex, Claude keychain)은 사용자 실행 호스트에 있다 → **세션은 항상 사용자 호스트에서 돌고, 서버는 원장과 전송만 담당한다.** 에이전트의 "조종"도 서버가 프로세스를 만지는 게 아니라, 호스트가 소비하는 원장 이벤트로 전달된다.
3. **기존 자산과의 정합이 이 설계의 핵심 논거**: 채팅→에이전트 트리거(mention→agent_run), 위험 행위 승인(approval pause/resume), 진행 스트리밍(agent.partial), 단일 쓰기경로(REST→PG→outbox→relay), 실행 호스트(BYOA) — **전부 랜딩돼 있다.** 본 ADR은 새 시스템이 아니라 이 다섯 자산을 "PTY 세션"이라는 새 객체에 재사용하는 계약이다.

## Options

### D1. 실행 호스트 — 세션(사람 직접·에이전트 스폰 모두)은 어디서 도는가
- **A (권고, v0) — 사용자 실행 호스트의 세션 매니저(앱 내장)**: macOS 앱이 세션 매니저를 내장 — 사람 직접 세션과 에이전트 스폰 세션 모두 여기서 PTY로 돈다. 자격증명 소재지(사용자 맥)와 실행 위치가 일치. 데몬 승격(momo-workd: 앱 종료 생존·헤드리스 호스트·원격 attach)은 내부 프로토콜 경계만 v0에 새겨 두고 v1로.
- B — 전용 러너(서버 옆 컨테이너): 자격증명을 러너에 넣어야 함 — 하드 경계 위반 소지 + BYOA 정신 훼손. **기각**(팀 공용 러너가 필요해지면 별도 ADR).

### D2. 세션의 물화 — 채팅과 양방향이 되려면 세션은 무엇이어야 하는가
- **A (권고) — 세션 = 채널의 스레드**: 세션 시작 시 채널에 **세션 카드(root 메시지)**가 서고, 진행·출력 발췌·결과는 그 **스레드 답글**로, 사람의 개입 입력은 **같은 스레드에 답글**로 쓴다(스레드 인프라 X-3로 랜딩 완료). 원장 철학 그대로 — 누가, 어떤 도구로, 무엇을 승인받아, 어떤 결과를 냈는지가 채널 타임라인에 남는다. iOS/웹은 v0에서 이 스레드만으로 관전·개입 가능(터미널 뷰 없이).
- B — 별도 세션 객체(채널 밖): 새 조회/알림/권한 체계가 통째로 필요. **기각.**

### D3. 채널로 흐르는 콘텐츠 수위 (시크릿 방어)
- **A (권고) — 기본=큐레이션, 옵트인=raw tail**: 기본 모드에서 스레드에 남는 것은 ①세션 수명주기(시작/종료/exit) ②에이전트가 큐레이션한 진행 요약·산출물 청크 ③사람이 터미널에서 명시 선택한 발췌. **raw 전체 스트림은 로컬 터미널 뷰에서만.** 세션 단위 토글로 raw tail 스트리밍 옵트인 가능(시크릿 노출 경고 + 서버 원장에 저장됨을 명시). env/토큰 echo가 흔한 터미널 특성상 기본 raw는 위험.
- B — 기본 raw 스트리밍: Warp도 공유는 명시적이다. **기각.**

### D4. 에이전트 조종 프로토콜 — "에이전트가 세션을 만들고 다룬다"의 배선
- **A (권고) — 원장 경유 control 이벤트**: 에이전트(agent_run)가 세션 조작을 **tool-call**로 요청(`work.spawn`/`work.input`/`work.read`/`work.kill`) → 서버가 원장 기록(+D5 승인 게이트) → outbox `work.control.*` 이벤트 → **사용자 호스트의 세션 매니저가 자기 앞으로 온 control을 구독·실행** → 결과를 세션 스레드로 회신. 단일 쓰기경로 유지, 서버는 여전히 프로세스 무접촉. 사람이 채팅에서 "이거 빌드해줘"라고 하면: mention→agent_run→에이전트가 work.spawn tool-call→(승인)→내 맥에서 codex 세션 시작→진행이 스레드로.
- B — 호스트에 직접 WebSocket 명령(원장 우회): Centrifugo=전송전용·단일 쓰기경로 불변식 위반. **기각.**

### D5. 승인 경계 — 에이전트가 내 머신에 프로세스를 만드는 행위
- **A (권고) — spawn은 승인 대상, 프로파일별 auto-approve 화이트리스트**: 에이전트의 `work.spawn`은 기존 승인 원장(pause/resume)을 통과한다. 사용자가 프로파일 단위로 auto-approve를 켤 수 있고(예: "codex 프로파일은 자동 허용") 그 설정 변경 자체도 감사 원장에 남는다. `work.input`은 활성 세션 내에서는 free(세션 승인에 포괄), `work.kill`은 free. 사람 직접 조작은 승인 불요.
- B — 전부 자동 허용: "에이전트가 내 맥에서 임의 프로세스"는 momo의 승인 원장 차별화가 가장 빛나는 지점을 버리는 것. **기각.**

### D6. 표면
- **A (권고) — 터미널 뷰 + 스레드 브리지 병행**: macOS는 SwiftTerm(MIT) 임베드 — Work 서랍(Control+backtick, MOMO-375 승계)에 세션 목록+활성 터미널. 같은 세션이 채널 스레드로도 보인다(D2). 사람은 어느 쪽에서든 개입: 터미널에 직접 타이핑하거나, 스레드에 답글(→ work.input). iOS/웹 v0 = 스레드만.
- 디자인: momo-design-taste — agentPayloadMono 토큰, 시스템 우선, 상태 칩은 기존 run 수명주기 칩 재사용.

### D7. 도구 모델
- **A (권고) — 도구-불가지 프로파일**(이름·명령 템플릿·cwd·env 화이트리스트, 기본 3종 claude/codex/opencode + 임의 셸). interactive 세션 안에서 뭘 돌리든 momo는 불가지. 도구 내부 통합(transcript 파싱·세션 이어받기)은 후속 플러그인.

### D8. 호스트 추상화 훅 (v1 예약 — ADR-0125 연계)
- **A (권고) — `work_session`·`work.control.*`은 host_id를 필수로 가진다**: v0의 유일 호스트는 맥 앱이지만, 이 필드 하나로 v1의 self-host workd(SSH 부트스트랩·outbound-only 다이얼)와 momo Cloud 샌드박스(유료)가 같은 계약 위에 선다 — 3계층·라우팅·경제 모델은 research/17-work-host-fabric/00 + ADR-0125(기안 예정)로 위임. 본 ADR에서는 이 필드 계약만 결정해 v0 구현이 T2/T3를 막지 않게 한다.

## Decision (Proposed v2 권고안)

D1-A(호스트 세션 매니저) · D2-A(세션=스레드) · D3-A(큐레이션 기본·raw 옵트인) · D4-A(원장 경유 control) · D5-A(spawn 승인+화이트리스트) · D6-A(터미널+스레드 병행) · D7-A(도구-불가지 프로파일) · D8-A(host_id 훅) — **2026-07-19 성재 승인, Accepted.**

## 파생 (Accepted 후 발급 예약)

- **MOMO-483** (엔진 1): `work_session` 원장(테이블·RLS FORCE·라벨만 저장) + 세션 카드/스레드 바인딩 + REST 수명주기 + outbox `work.session.*` + Core kind 가산 + verifier `[runtime-db]`
- **MOMO-484** (엔진 2): control 계약 — `work.spawn/input/read/kill` tool-call 스키마 + 승인 게이트 연동(auto-approve 화이트리스트 포함) + outbox `work.control.*` + 호스트 ack/실패 회신 + verifier(승인 우회 불가 단정) `[runtime-db]`
- **MOMO-485** (UXUI): SwiftTerm 임베드 + Work 서랍(세션 목록·터미널·프로파일) + 스레드 브리지 UI(발췌 공유·raw 토글) + 스폰 승인 카드. MOMO-375 승계·종결.
- **MOMO-486** (엔진 3): AgentWorker tool 노출 — 에이전트가 work.* tool을 인지·호출하는 프롬프트/디스패치 + E2E verifier(채팅 요청→spawn 승인→mock CLI 세션→스레드 회신).
- 후속 예약: momo-workd 데몬(원격/상시 호스트), 채널↔repo 바인딩, 팀 공용 러너 ADR, 도구별 플러그인.

## 배포판 App Sandbox 경계 (2026-07-20 A-10 구현 중 발견, 보강)

- **dev(SwiftPM) 빌드**: 앱 내장 PTY(D1-A) 동작 — 현재 dogfood 경로.
- **배포(Xcode App Sandbox) 빌드**: App Sandbox가 임의 자식 프로세스/PTY를 제약 → A-10은 샌드박스에서 **fail-closed**(안전 기본값, 머지 blocker 아님).
- **배포판에서 PTY를 여는 결정**: 로드맵상 답은 이미 있다 — **배포판 앱은 샌드박스 유지 + PTY는 비샌드박스 로컬 helper(ADR-0125 momo-workd, T2)에 위임**. 이러면 App Store 경로도 열린다. App Sandbox 해제(직접배포 전용)는 대안이나 스토어 경로를 닫으므로 비권장.
- 확정 시점: M8 스토어 배포 또는 배포판 dogfood 선행. 그 전까지 dev 빌드로 A-10 사용. 추적: `docs/planning/QA_FOLLOWUP.md` Q2.

## Consequences

- (+) "채팅에서 시키면 에이전트가 내 맥에서 CLI를 돌려 일한다"가 기존 원장 불변식 안에서 성립 — 서버는 여전히 프로세스·자격증명·raw 무접촉.
- (+) 세션=스레드라 iOS/웹·타 팀원이 즉시 관전·개입 가능, 승인 원장이 "에이전트의 내 머신 접근"이라는 신뢰 문제의 답이 됨.
- (−) v0 세션은 호스트 앱 수명에 묶임(맥 앱이 꺼지면 에이전트도 세션을 못 만듦 — workd 전까지의 명시 한계).
- (−) 원장 경유 control은 직결보다 지연이 있다(outbox→relay 홉). 타이핑 상호작용은 로컬 터미널이 담당하므로 실사용 임팩트는 스폰/개입 명령 수준.
- (−) 큐레이션 기본이라 채널 기록은 완전 transcript가 아니다 — 필요 시 raw 옵트인.

---

## 증보 1 — work host의 배포판 동봉 + GUI 페어링 (2026-07-23 기안 · 2026-07-24 엔진 매트릭스 확장, 성재 발제)

- Status: **Proposed** (2026-07-23 momo-main 기안 → 2026-07-24 goose 단독에서 goose∪opencode 양자 동봉안으로 확장 재기안 — 성재 "opencode·goose 둘 다" 지시. 승인 시 구현. "코드 실행을 CLI 수동 등록이 아니라 배포판에 담아 GUI로 매끄럽게" 요구. buzz 실측: 코드 에이전트는 동봉 아닌 ACP 접속 — momo도 동형이나 페어링 UX가 수동)
- 발단: 성재는 코드 실행 에이전트(Codex/goose)를 "담아서 띄우는" 경험을 원한다. buzz 검증 결과 Codex 자체는 독점 CLI+OAuth라 buzz도 동봉하지 않고 ACP로 접속한다(momo ADR-0114와 동형). 갭은 **①work host가 배포판에 안 담겨 사용자가 별도 실행 ②페어링이 host ID 수동 복사(TUI)**다. 자격증명 경계(본문 §하드 경계 불변, ADR-0004)는 유지한다.

### D1. work host를 single image 배포판에 사이드카로 동봉
- 565 단일 이미지 옆에 **work host 사이드카 서비스**(compose `--profile workhost` opt-in)를 배포판에 포함해, 설치 시 ACP 브리지가 이미 떠 있게 한다. 서버는 여전히 프로세스·자격증명 무접촉(본문 불변) — 사이드카는 사용자가 지정한 호스트/자격증명으로만 CLI를 실행하는 소비자다.
- **동봉 대상은 재배포 가능 라이선스(퍼미시브)의 오픈소스 에이전트로 한정**. 후보 2종(2026-07-24 확인):

| 엔진 | 라이선스 | 정체 | provider 중립 | 연결 경로 | 동봉 | 비고 |
|---|---|---|---|---|---|---|
| **goose** (Block) | Apache-2.0 | 독립 에이전트, MCP 확장 | ✅ BYO 모델 | ACP | ✅ 바이너리 | buzz 1급 지원 근거, Block 백킹·MCP 생태계 |
| **opencode** (opencode.ai / Anomaly·SST) | MIT | 독립 에이전트, build/plan 모드, 75+ 모델 | ✅ Anthropic/OpenAI/Ollama | **서버-클라(로컬 서버)** — 임베드 API는 스파이크 확인 | ✅ 바이너리 | 서버-클라 구조라 프로그램으로 몰기 유리(가설) |
| Codex / Claude Code | 독점 | 독립 에이전트 | — | ACP 또는 Codex app-server JSON-RPC(stdio, t3code 실증) | ❌ 불가 | 사용자 호스트의 것 로컬 연결(`~/.codex`·keychain 그대로) |

- **v0 동봉 엔진 = opencode 우선 + goose 병행**(사용자가 설정에서 선택). 근거: opencode(MIT, 더 느슨)가 (a) 서버-클라 구조로 momo가 GUI로 몰기 수월할 여지, (b) 데스크톱 배포 경험 보유. goose는 MCP 확장·Apache-2.0으로 병행 가치. **단, opencode의 실제 임베드/헤드리스 API 표면은 미확정 — WH-0 스파이크로 검증 후 최종 확정**(검증 실패 시 goose 단독으로 후퇴).
- **Codex/Claude Code는 독점이라 동봉 불가 — 사용자 호스트의 것을 연결**. 연결 프로토콜은 ACP 외에 **Codex app-server JSON-RPC(stdio) 경로도 후보**(t3code가 실증) — WH-0에서 함께 판정.

### D2. GUI 페어링 (host ID 수동 복사 제거)
- 관리자 설정 "코드 실행 호스트" 화면: 사이드카/로컬 호스트를 **자동 발견·페어링**(단기 페어링 코드 or 서명 challenge)하고 상태(연결됨/오프라인/도구 목록)를 표시. 현재 `MOMO_WORK_HOST_ID` 수동 조율(A-11)을 대체. ADR-0004 증보 1의 provider GUI와 **한 설정 화면에서 구분 표기**(LLM provider vs 코드 실행 호스트).

### D3. 자격증명 경계 불변 (재확인)
- 사이드카가 동봉돼도 **Codex OAuth·provider 키는 서버/DB/원장 비유입**(ADR-0004). 사이드카는 사용자 호스트 자격증명 소비자일 뿐, momo 서버 컨테이너와 신뢰 경계 분리. goose를 쓰더라도 goose가 호출하는 LLM 자격은 goose 설정(사용자) 소유.

### D4. 스코프 경계
- v0: **opencode(우선)+goose 사이드카 동봉** + GUI 페어링 + 상태 + 엔진 선택. Codex/Claude Code는 로컬 연결(GUI 페어링 공유). 원격 workd 다중 호스트·풀은 후속(ADR-0125 계보).
- **WH-0(스파이크)가 D1 확정의 게이트**: opencode 임베드/헤드리스 API가 프로그램 구동 불가로 판명되면 v0은 goose 단독으로 축소하고 opencode는 후속으로 미룬다(스코프 축소는 성재 통보).

### 파생 (Accepted 후)
| 후보 | 내용 | 트랙 |
|---|---|---|
| **WH-0** | **스파이크: opencode 임베드/헤드리스 구동 API 표면 + Codex app-server JSON-RPC(stdio) 연결 경로 검증** — work host 연결을 ACP∪JSON-RPC로 넓힐지, opencode 동봉이 가능한지 판정(D1/D4 게이트) | 엔진 |
| WH-1 | work host 사이드카 compose 프로파일 + 동봉 엔진 이미지(opencode+goose, single image 계보) + 엔진 선택 배선 | 엔진 |
| WH-2 | GUI 자동 페어링(코드/challenge)+상태 화면+엔진 선택 UI(provider GUI와 통합 설정) | UXUI |
| WH-3 | 배포판 문서: "코드 실행 호스트 5분 연결"(opencode/goose 동봉·Codex 로컬) | docs |

### Consequences
- (+) "코드 실행을 담아서 띄움"의 realizable 버전 — 퍼미시브 오픈소스(opencode MIT·goose Apache-2.0)는 동봉·사용자 선택, 독점(Codex)은 GUI 로컬 연결. buzz와 동형이되 페어링이 GUI + 엔진 선택지.
- (+) ADR-0004 경계 불변 — 사이드카는 자격증명 소비자, 서버 무접촉 유지. 동봉 엔진이 호출하는 LLM 자격은 엔진 설정(사용자) 소유.
- (+) 엔진 2종 지원으로 특정 벤더 종속 회피 + provider GUI("AI 연결")로 붙인 모델을 그대로 물림.
- (−) 사이드카 이미지 크기(엔진 2종+런타임)·compose 표면 증가(opt-in·엔진별 레이어 분리로 상쇄). WH-0 전까지 opencode 임베드 가능성 미확정 리스크.
- 예약: Codex 자체 동봉(독점상 불가), 원격 호스트 풀, mesh-llm식 오픈모델 추론 동봉(별도).
- 근거 문서: 엔진 후보 비교·t3code 경쟁 분석 = `docs/planning/2026-07-24-t3code-competitive-analysis.md`.
