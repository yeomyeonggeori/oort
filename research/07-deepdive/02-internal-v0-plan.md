# 내부-우선 v0 구현 계획 — 팀 메신저 + 김인턴(에이전트) 무대

> **전제 문서:** `07-deepdive/01-agent-native-mac-messenger.md` (에이전트 멤버십 레이어 = 제품의 전부 / MIT·Apache만 차용 / 인바운드 MCP ≠ 아웃바운드 실행루프 / 폭주 안전장치)
> **새 맥락:** ≤5명 사내 팀, 내부 테스트, 이미 Mattermost(self-host) 운영 중, 외부 상용배포 아님, macOS(Swift) + iOS 둘 다, 에이전트 "김인턴"(hermes agent류) 1급 구성원화.
> **면책:** 본 문서는 법률 자문이 아니다. 라이선스 결론은 1차 텍스트·공식 FAQ 종합 해석이며, 외부 배포/상용 SaaS 전환 전 변호사 검토 필요.

---

## 1. 전제 변화와 함의 — 내부-우선이 바꾸는 것

내부-우선(≤5명, 무외부배포, 이미 Mattermost 운영)이라는 새 맥락은 직전 deep-dive의 여러 보수적 가정을 *완화*한다. 단, 에이전트 멤버십 레이어가 제품의 전부라는 핵심 명제는 **그대로 유지·강화**된다(내부 테스트에서도 김인턴 무대가 곧 검증 대상).

| 영역 | 이전 가정 (deep-dive 01) | 새 결론 (내부-우선 v0) |
|---|---|---|
| **AGPL copyleft** | 자체 백본 가정 → MIT/Apache만 차용, AGPL 회피 | **AGPL는 내부사용에서 사실상 무부담.** 미수정 self-host = 의무 0. 서버를 수정해도 §13 의무는 *내 직원(=네트워크 사용자)에게만* 소스 제공 — 공개 의무 없음 ([AGPLv3 §13](https://www.gnu.org/licenses/agpl-3.0.en.html), [FSF #UnreleasedModsAGPL](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL), [#InternalDistribution](https://www.gnu.org/licenses/gpl-faq.html#InternalDistribution)) |
| **백본 선택** | 자체 백본 직접 구축이 1급화의 전제 | **기존 Mattermost를 백본으로 재사용**이 최저위험·최속. 자체 백본은 v1의 *트리거 조건부* 과제로 후순위 |
| **클라이언트 라이선스** | 자체 클라이언트 = 자체 IP | **변하지 않음.** REST/WS API만 호출하는 별개 Swift 클라이언트는 별개 저작물 → 비공개 유지 가능 ([FSF #MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)) |
| **앱스토어/GTM** | 심사·IAP·UGC 모더레이션 대비 필요 | **후순위.** macOS = Developer ID 직접배포(심사 X), iOS = TestFlight 내부 테스터(베타리뷰 X). IAP 3.1.1·UGC 1.2는 외부 출시 시점까지 백로그로 ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), [Developer ID](https://developer.apple.com/support/developer-id/)) |
| **self-host** | 옵션 중 하나 | **당연 전제.** 이미 운영 중이므로 추가 인프라 결정 불필요(단, 모바일 push proxy는 신규 항목 — §3 참조) |
| **에이전트 범위** | 다중 에이전트 / A2A 고려 | **김인턴 단일 우선.** 멀티에이전트·A2A는 Phase 3으로 미룸 |
| **인바운드 vs 아웃바운드** | 인바운드 MCP ≠ 아웃바운드 실행루프 (구분 유지) | **변하지 않음·강화.** MM 봇은 *아웃바운드 실행루프*(WS 구독→기동→post)로 구현. 인바운드 MCP 서버 노출은 별개 관심사로 분리 유지 |
| **폭주 안전장치** | 필수 | **변하지 않음·필수.** 내부라도 김인턴의 자동 post/edit/도구실행 루프에 rate limit·승인게이트·kill-switch 유지 (§4) |
| **Enterprise 기능** | 미고려 | **신규 제약.** `server/enterprise` + Enterprise 기능은 Source Available License → dev/test 무료, *production 시 유료*. "테스트 vs production" 분류 확인 필요 ([MM Source Available FAQ](https://docs.mattermost.com/product-overview/faq-mattermost-source-available-license.html)) [추정: ≤5명 내부 테스트의 'testing' 해당 여부 — medium confidence] |

**한 줄 요약:** 내부-우선은 "백본을 새로 안 짜도 된다"를 열어주고, 절감된 노력 전부를 **김인턴 멤버십 레이어**(제품의 전부)에 집중하게 한다.

---

## 2. 권고 v0 경로

### 권고: **기존 Mattermost 백본 재사용 + 네이티브 Swift 클라이언트(Mac 우선, iOS 코어공유) + 김인턴 에이전트 워커 사이드카**

세 컴포넌트로 분해:

1. **백본 = 미수정 self-host Mattermost** — 채널/메시지/스레드/파일/리액션/presence/검색이 REST API v4 + WebSocket으로 전부 노출됨. 공식 웹·데스크탑·모바일 앱 자체가 *동일한 공개 API* 위에서 동작 → 3rd-party 클라이언트로 메신저 전 기능 구현이 기능적으로 충분함이 검증됨 ([posts.yaml](https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/posts.yaml), [introduction.yaml](https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/introduction.yaml)).
2. **클라이언트 = 네이티브 Swift** — Mac 먼저, iOS는 동일 코어(API 클라이언트/모델/렌더 로직) 공유. API만 호출 → AGPL 비전파, 비공개 유지.
3. **김인턴 = 에이전트 워커 사이드카** — bot user + PAT(무만료) + WS 구독 + `POST`/`PUT` 아웃바운드 루프를 도는 독립 데몬. 김인턴의 실제 인터페이스는 `AgentTransport` 어댑터 뒤로 흡수.

### 왜 가장 빠르고 위험이 낮은가

- **백본이 이미 검증·운영 중** — 메신저 기본기를 새로 짤 필요 없음. 팀이 이미 쓰고 있으므로 마이그레이션·운영 부담 0.
- **AGPL 내부사용 OK** — 미수정 서버 = 의무 없음; 수정해도 직원에게만 소스 제공(이미 사내 repo로 충족) ([§13](https://www.gnu.org/licenses/agpl-3.0.en.html), [#GPLRequireSourcePostedPublic](https://www.gnu.org/licenses/gpl-faq.html#GPLRequireSourcePostedPublic)).
- **아웃바운드 루프가 실증됨** — 봇 PAT 인증 + WS `posted` 구독 + `POST /posts` 후 `PUT /posts/{id}/patch` 반복편집(스트리밍 흉내)은 다수 봇/게이트웨이가 쓰는 패턴 ([bot-accounts](https://developers.mattermost.com/integrate/reference/bot-accounts/), [PAT](https://developers.mattermost.com/integrate/reference/personal-access-token/)).
- **클라이언트 IP 보존** — 별개 프로그램이라 비공개 유지 가능, 향후 가치 잠금.

### 대안 비교: 자체 백본 즉시 구축

| 기준 | 권고 (MM 재사용) | 대안 (자체 백본 즉시) |
|---|---|---|
| 첫 동작까지 | **~1주 스파이크** | 수개월 (메시지·채널·presence·검색·파일·실시간 전부 재구현) |
| 검증된 메신저 기본기 | ✅ MM이 제공 | ❌ 직접 검증해야 함 |
| 에이전트 1급화 자유도 | 봇 모델 제약 있음(§4·§5) | 완전 자유(능동 presence/모노토닉 seq/actor 토큰) |
| 내부 테스트 위험 | 낮음 | 높음(범위 폭발) |
| 김인턴 레이어 집중도 | **높음** (백본에 시간 안 씀) | 낮음 (백본에 시간 다 씀) |

**결론:** 자체 백본은 "에이전트를 진짜 1급 멤버로 만들고 싶을 때"의 *트리거 조건부* 과제이지 v0의 출발점이 아니다. v0는 MM 재사용으로 김인턴 무대를 빨리 띄우고, **클라이언트·에이전트 레이어를 백본 교체에도 캐리되도록 경계 설계**(§5)하는 것이 정답.

---

## 3. v0 아키텍처 (텍스트 다이어그램)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     사내 self-host 인프라                              │
│                                                                       │
│   ┌──────────────────────────┐         ┌────────────────────────┐    │
│   │  Mattermost Server        │         │  Agent Worker (김인턴)  │    │
│   │  (self-host, 미수정)       │◄───WS───┤  사이드카 데몬           │    │
│   │                           │  (posted │                        │    │
│   │  - REST API v4            │   구독)  │  - bot user + PAT(무만료)│    │
│   │  - /api/v4/websocket      │         │  - WS authentication_   │    │
│   │  - 채널/메시지/스레드      │──REST──►│    challenge → posted   │    │
│   │    /파일/리액션/presence   │ (POST/  │  - 멘션 감지 → 기동      │    │
│   │                           │  PUT    │  - AgentTransport 어댑터 │    │
│   │  라이선스: 미수정 바이너리  │  patch) │    └─[불명] 김인턴 호출   │    │
│   │  = MIT / 소스수정시 AGPLv3 │         │  - POST/PUT-patch 아웃   │    │
│   │  (내부사용 OK)            │         │    바운드 (스트리밍 흉내) │    │
│   └──────────────────────────┘         │  - presence/typing 능동  │    │
│            ▲         ▲                  │    토글 (워커 책임)       │    │
│            │REST/WS  │REST/WS           │  - 폭주 안전장치          │    │
│            │         │                  │    (rate/승인/kill)      │    │
│   ┌────────┴───┐ ┌──┴──────────┐        │  라이선스: 자체 IP        │    │
│   │ (선택) Push │ │             │        └────────────────────────┘    │
│   │ Proxy       │ │             │                                      │
│   │ (모바일용,   │ │             │                                      │
│   │  자체 APNs)  │ │             │                                      │
│   └─────────────┘ │             │                                      │
└───────────────────┼─────────────┼─────────────────────────────────────┘
                     │ REST/WS     │ REST/WS (+ APNs push)
          ┌──────────┴───┐    ┌────┴──────────┐
          │ Swift macOS   │    │ Swift iOS      │
          │ 클라이언트     │    │ 클라이언트      │
          │ (1급 트랙)     │    │ (thin client)  │
          │               │    │                │
          │ 공유 코어:     │◄──►│ 공유 코어 재사용 │
          │ - API client  │    │ - push 수신     │
          │ - 모델/스레드  │    │ - FG 풀동기화   │
          │ - 에이전트 렌더 │    │ - 상주로직 X    │
          │ 라이선스:자체IP │    │ 라이선스:자체IP │
          └───────────────┘    └────────────────┘
```

### 컴포넌트별 책임·라이선스

| 컴포넌트 | 책임 | 라이선스 |
|---|---|---|
| **Mattermost Server** | 메시지/채널/스레드/파일/리액션/presence/검색의 source of truth, REST v4 + WS 노출. **미수정 운영.** | 공식 컴파일 바이너리 = **MIT** ([LICENSE.txt](https://github.com/mattermost/mattermost/blob/master/LICENSE.txt)). 소스 직접 수정 시에만 AGPLv3/상용. 미수정 self-host = 의무 0 ([#UnreleasedMods](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods)). **주의:** Enterprise 기능은 Source Available(production 유료) [추정: 내부테스트=testing — medium] |
| **Agent Worker (김인턴 사이드카)** | bot user 소유, WS 1개로 `posted`/멘션 수신, `AgentTransport`로 김인턴 호출, REST로 결과 write, presence/typing 능동 토글, 폭주 안전장치 | **자체 IP** (별개 프로그램) |
| **Swift macOS 클라이언트** | 1급 메신저 UX + 에이전트 렌더(presence·툴콜·diff·승인카드), 공유 코어 보유 | **자체 IP.** API만 호출 → AGPL 비전파 ([#MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)) |
| **Swift iOS 클라이언트** | thin client: push 수신 + FG 풀동기화. 상주 에이전트 로직 없음(서버에 둠) | **자체 IP** (공유 코어 재사용) |
| **(모바일용) Push Proxy** | 자체 iOS 앱은 무료 TPNS/HPNS 불가 → 오픈소스 push proxy + 자체 APNs `.p8` 키 운영 | 오픈소스 MM push service. 자체 키 ([mobile-hpns](https://docs.mattermost.com/deploy/mobile-hpns.html)) |

> **경계 규칙(라이선스 안전):** 클라이언트·워커는 (1) 서버 소스를 복사하지 말 것, (2) 서버 라이브러리를 링크하지 말 것, (3) 서버 내부 자료구조를 공유메모리로 교환하지 말 것. 오직 documented REST/WS API만 ([#GPLInProprietarySystem](https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem)).

---

## 4. 김인턴 무대 설계

### 4.1 아웃바운드 실행루프 (인바운드 MCP와 분리 — deep-dive 전제 유지)

```
1. WS 연결: bot PAT로 /api/v4/websocket → authentication_challenge
2. 구독: posted 이벤트 수신 (★ 김인턴이 활동할 모든 채널에 봇을 멤버로 add — 필수)
3. 멘션 감지 → 기동
4. presence 능동 ON: PUT /users/{bot}/status (online) + user_typing WS 요청
5. placeholder post: POST /posts ("생각 중...")
6. AgentTransport로 김인턴 호출 → 토큰 누적
7. 점진 갱신: PUT /posts/{id}/patch 주기적(0.5~1s 또는 N토큰마다) — 스트리밍 흉내
8. 완료: 최종 message로 마무리. 답글이면 root_id로 스레드에 묶음
9. presence 능동 OFF (멘션 처리 구간에만 토글)
```

근거: [bot-accounts](https://developers.mattermost.com/integrate/reference/bot-accounts/), [PAT 무만료](https://developers.mattermost.com/integrate/reference/personal-access-token/), [post patch 가능](https://forum.mattermost.com/t/impossible-to-update-a-post-through-api-with-bot-account/7795), WS 이벤트([introduction.yaml](https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/introduction.yaml)).

> **★ 가장 중요한 운영 제약:** 봇은 *채널 멤버일 때만* 그 채널 `posted` 이벤트를 받는다(membership-scoped 브로드캐스트). DM은 자동 수신되나 일반 채널은 멤버십 필수 ([WS 수신자 포럼](https://forum.mattermost.com/t/websocket-does-not-provide-posted-events-from-other-accounts/14876)). → "모든 채널 감시(omniscient)"는 불가. **김인턴 전용 채널 + 명시적 초대 모델**로 UX 설계.

### 4.2 클라이언트측 에이전트 렌더

MM의 메시지 primitive 위에 에이전트 어포던스를 매핑(공식 클라이언트도 렌더하는 검증된 primitive):

- **presence (working / awaiting-approval / idle)** — 봇 status API + 클라이언트측 커스텀 렌더. MM 기본 presence는 online/away/offline/dnd뿐이므로, "working"·"awaiting-approval" 같은 *세밀한 에이전트 상태*는 **클라이언트가 post props/메타데이터를 읽어 렌더**하는 방식으로 보강(서버 상태는 online, 의미 레이어는 클라이언트).
- **툴콜 카드 / diff / 승인카드** — message `props.attachments`(color/fields/footer/image) + interactive `actions`(버튼/메뉴, HTTP POST 엔드포인트 백엔드)로 표현 가능 ([interactive-messages](https://developers.mattermost.com/integrate/plugins/interactive-messages/)). 자체 Swift 클라이언트라면 이 props를 *원하는 만큼 리치하게* 렌더 가능.
- **경량 감사(actor/subject)** — 각 김인턴 액션 post에 actor(김인턴)·subject(영향 대상)·도구명·승인자를 props로 기록, 클라이언트가 감사 드로어로 표시. [추정: MM 자체엔 actor 토큰 개념 없음 → 클라이언트/워커 레이어가 메타데이터로 흉내 — medium]
- **AgentTransport([불명] 인터페이스 흡수)** — 김인턴 실제 인터페이스가 미확정이므로, 워커에 `AgentTransport` 추상화를 두고 hermes-agent류/HTTP/CLI/MCP 어느 형태든 어댑터로 감싼다. 이 경계가 §7의 핵심 미결정을 격리한다.

### 4.3 폭주 안전장치 (deep-dive 전제 — 내부라도 필수)

- per-channel/per-minute **rate limit** (post·patch·tool-call)
- 파괴적 도구실행은 **승인카드 게이트**(awaiting-approval presence → 사람 버튼 클릭 후 진행)
- 워커 전역 **kill-switch** (env/관리 채널 커맨드)
- patch 호출 빈도는 MM rate limit 고려해 조절(과도한 PUT 방지).

### 4.4 MM 봇 "2급 시민" 한계를 클라이언트 렌더로 어디까지 가리나

공식 문서가 명시한 봇 제약은 **4가지뿐**: (1) 로그인 불가, (2) 다른 봇 생성 불가, (3) 파일 업로드는 채널 멤버일 때만, (4) Enterprise 사용자 수 미포함 ([bot-accounts](https://developers.mattermost.com/integrate/reference/bot-accounts/)). presence/typing/메시지타입에 대한 *명시적 봇 전용 제약은 문서에 없음*.

| 봇 한계 | 클라이언트 렌더로 가림 가능? | 방법 / 잔존 한계 |
|---|---|---|
| presence 자동관리 안 됨(워커가 직접 호출) | ✅ 대부분 | 워커가 능동 토글 + 클라가 "working/awaiting-approval" 의미 렌더. 잔존: 토글은 워커 책임 |
| 세밀한 에이전트 상태 없음 | ✅ | post props 메타데이터를 클라가 읽어 pill/스피너 렌더 |
| 리치 인터랙션 | ✅ | props.attachments + actions, 자체 클라면 자유 렌더 |
| "진짜 스트리밍" 없음 | △ 부분 | PUT-patch 폴링으로 흉내 — UX 유사하나 짧은 깜빡임 가능 |
| 채널 멤버십 스코프(omniscient 불가) | ❌ 못 가림 | 메커니즘 제약. UX(전용채널+초대)로 회피 |
| 로그인/대화형 세션 없음 | ❌ 못 가림 | 봇 본질 제약 → 자체 백본 트리거(§5) |

**요지:** *렌더링 가능한* 한계(presence 의미·리치 카드·감사)는 클라이언트로 거의 다 가린다. *메커니즘적* 한계(멤버십 스코프, 능동 1급 세션)는 못 가린다 → 이것이 v1 백본 전환 트리거.

---

## 5. MM 봇 한계 → 자체 백본 전환 기준 (v1)

다음 중 하나가 *핵심 요구*가 되면 봇 모델이 막히고 자체 백본 검토:

| 트리거 | 무엇이 막히나 | 근거 |
|---|---|---|
| **능동 presence / 전채널 가시성** | 봇 add 없이 모든 채널 자동 가시화 불가(멤버십 스코프) | [WS 멤버십 브로드캐스트](https://forum.mattermost.com/t/websocket-does-not-provide-posted-events-from-other-accounts/14876) |
| **모노토닉 seq** | MM은 클라이언트가 신뢰할 글로벌 모노토닉 메시지 시퀀스를 1급 보장하지 않음 → 정렬/dedup을 클라가 보정 [추정: medium] | — |
| **actor 토큰** | 김인턴이 *대신 행동*할 때의 1급 actor/on-behalf-of 토큰 모델 없음(봇 단일 정체성) | [bot-accounts](https://developers.mattermost.com/integrate/reference/bot-accounts/) |
| **다중에이전트 동시성** | 여러 에이전트가 1급 멤버로 동시 활동·상호작용(A2A) — 봇 다수는 가능하나 1급 세션/조정 레이어 부재 | — |
| **진짜 스트리밍 / 자유 메시지 타입** | PUT-patch 흉내 대신 서버 푸시 토큰스트림, props 범위 넘는 커스텀 타입 | [interactive-messages](https://developers.mattermost.com/integrate/plugins/interactive-messages/) |
| **외부 배포 / 상용 SaaS** | AGPL §13(외부 네트워크 사용자에 소스 제공)·HPNS 약관·앱스토어 심사 부활 | [§13](https://www.gnu.org/licenses/agpl-3.0.en.html) |

### 경계를 어디에 그어 클라이언트/에이전트 레이어를 캐리하나

자체 백본으로 갈아타도 다시 안 짜도록, **API 추상화 계층**을 v0부터 박아둔다:

```
[Swift 공유 코어]  ─→  ChatBackend 프로토콜  ─→  (v0) MattermostBackend
                                              └→  (v1) OwnBackend
[Agent Worker]     ─→  AgentTransport 어댑터  ─→  김인턴([불명])
                   ─→  BackendGateway        ─→  (v0) MM REST/WS
                                              └→  (v1) 자체 API
```

- 클라이언트는 MM 엔드포인트를 직접 호출하지 말고 `ChatBackend` 프로토콜 뒤에 둔다 → 백본 교체 시 어댑터만 교체.
- 에이전트 렌더(props 기반 카드/감사/presence 의미)는 *데이터 모델* 수준에서 정의 → 백본 무관 캐리.
- 워커의 `AgentTransport`(김인턴 흡수)와 `BackendGateway`(MM 흡수)를 분리 → 백본만 바뀌고 김인턴 연동은 불변.

---

## 6. 수정 로드맵

### Phase 0 — 스파이크 (~1주)
- **산출물:** (a) Swift CLI/최소앱이 MM v4 REST로 채널 read + post write, WS로 `posted` 수신. (b) 김인턴 봇이 1회 멘션 → `AgentTransport` 통해 응답 1개 post.
- **성공기준:** 멘션→김인턴 응답 왕복 1회 성공, WS posted 수신 확인, 봇 PAT 인증 동작.
- **난관:** ★봇을 채널 멤버로 add 안 하면 posted 안 옴(필수 체크). 봇 self-status PUT가 인스턴스 버전/권한에 따라 다를 수 있어 1회 실증 필요(version-dependent, medium).

### Phase 1 — 내부 dogfood MVP (4~8주, in/out)
- **산출물:** macOS Swift 클라(채널/스레드/파일/리액션/검색/presence) + 김인턴 아웃바운드 루프(placeholder→patch 스트리밍 흉내, 스레드 root_id, presence/typing 능동 토글) + 클라측 에이전트 렌더(툴콜/diff/승인카드, 경량 감사) + 폭주 안전장치(rate/승인/kill).
- **성공기준:** 5명이 일상 메신저로 dogfood, 김인턴이 전용채널에서 1급처럼 동작(working/awaiting-approval 렌더, 승인카드 클릭→실행). `ChatBackend`/`AgentTransport` 추상화 박힘.
- **난관:** patch 빈도 vs rate limit 튜닝, 깜빡임, 승인게이트 UX, props 스키마 설계.

### Phase 2 — 모바일 (TestFlight)
- **산출물:** iOS thin client(공유 코어 재사용, push 수신 + FG 풀동기화) + **자체 push proxy**(오픈소스 MM push service + 자체 APNs `.p8`) + TestFlight 내부 테스터 배포 + 90일 만료 대비 CI 자동 빌드 파이프라인.
- **성공기준:** 5명 TestFlight 즉시 수령(베타리뷰 X), alert push(priority 10)로 김인턴 멘션 즉시 도달, FG 복귀 시 풀동기화로 누락 복구.
- **난관:** ★자체앱은 무료 TPNS/HPNS 불가 → push proxy 필수 운영 ([mobile-hpns](https://docs.mattermost.com/deploy/mobile-hpns.html), [push service](https://developers.mattermost.com/contribute/more-info/mobile/push-notifications/service/)). iOS 상주연결 불가 → 상주로직은 서버에. silent push 전달 보장 X(시간당 2~3개 권고) → 중요 메시지는 visible alert push ([pushing-background-updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)). TestFlight 빌드 90일 만료 ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)).

### Phase 3 — 자체 백본 / 멀티에이전트 / A2A
- **산출물:** §5 트리거 충족 시 `OwnBackend` 구현(능동 presence·모노토닉 seq·actor 토큰·다중에이전트 동시성), 클라/에이전트 레이어는 어댑터 교체로 캐리. (외부 배포 고려 시 별도 트랙: 변호사 검토 + UGC 모더레이션 1.2 + IAP 3.1.1 + 앱스토어 심사).
- **성공기준:** 백본 교체에도 클라이언트/김인턴 연동 코드 변경 최소, 다중 에이전트 1급 동시 활동.
- **난관:** 메신저 기본기 재구현 범위 폭발, 외부 배포 시 라이선스/심사/약관 부활.

---

## 7. 남은 결정

1. **김인턴 실제 인터페이스 스펙 [확인 필요·블로킹]** — hermes-agent류의 실제 호출 방식(HTTP/CLI/MCP/SDK?), 스트리밍 지원 여부, 도구콜/승인 콜백 모델. `AgentTransport` 어댑터 설계가 여기에 의존. *현 검증 범위에서 인터페이스 = 불명.* Phase 0 전 확정 권장.
2. **MM 유지 vs 자체 전환 시점** — §5 트리거(능동 presence / 모노토닉 seq / actor 토큰 / 다중에이전트 / 외부배포) 중 무엇을 "필수"로 승격할지 팀 결정. 그 전까지는 MM 재사용이 비용 대비 최적.
3. **모바일 우선순위** — iOS를 Phase 2로 두는 것이 권고(push proxy·90일·thin client 부가비용). 데스크탑 dogfood가 충분히 안정화된 뒤 착수할지, 병렬로 당길지 결정.
4. **Enterprise/production 라인 [확인 필요]** — 어떤 기능이 Source Available(production 유료)인지 감사하고, ≤5명 내부 테스트가 'testing'으로 분류되는지 Mattermost에 확인 ([Source Available FAQ](https://docs.mattermost.com/product-overview/faq-mattermost-source-available-license.html)) [medium].
5. **AGPL 버전·외부배포 게이트** — repo LICENSE.txt는 AGPL v3.0(문서 일부는 'AGPLv2' 표기 — 문서 지연). 내부단계 위험 낮음. **외부배포/상용 SaaS 직전 변호사 검토 필수**(트리거: 수정 바이너리 외부 배포 / 수정 서버를 외부 네트워크 사용자에 노출) ([§13](https://www.gnu.org/licenses/agpl-3.0.en.html), [#InternalDistribution](https://www.gnu.org/licenses/gpl-faq.html#InternalDistribution)).

---

## 8. 출처

**라이선스 (AGPL/MIT/Source Available)**
- AGPLv3 §13 전문: https://www.gnu.org/licenses/agpl-3.0.en.html
- FSF FAQ #UnreleasedMods (미배포 수정): https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods
- FSF FAQ #UnreleasedModsAGPL (내부 웹사이트 §13): https://www.gnu.org/licenses/gpl-faq.html#UnreleasedModsAGPL
- FSF FAQ #InternalDistribution (내부 = 배포 아님): https://www.gnu.org/licenses/gpl-faq.html#InternalDistribution
- FSF FAQ #GPLRequireSourcePostedPublic (공개 의무 없음): https://www.gnu.org/licenses/gpl-faq.html#GPLRequireSourcePostedPublic
- FSF FAQ #MereAggregation (소켓=별개 프로그램): https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
- FSF FAQ #GPLInProprietarySystem (arm's-length 경계): https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem
- MM LICENSE.txt: https://github.com/mattermost/mattermost/blob/master/LICENSE.txt · https://raw.githubusercontent.com/mattermost/mattermost/master/LICENSE.txt
- MM Source Available License FAQ: https://docs.mattermost.com/product-overview/faq-mattermost-source-available-license.html
- MM 라이선스 FAQ (Advanced Licensing Option): https://docs.mattermost.com/product-overview/faq-license.html
- MM MIT 발표 포럼: https://forum.mattermost.com/t/mattermost-releases-under-mit-license-agpl-does-not-apply/273

**Mattermost API / 봇 / 푸시**
- posts.yaml (REST v4): https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/posts.yaml
- introduction.yaml (WebSocket 이벤트): https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/introduction.yaml
- status.yaml (presence): https://github.com/mattermost/mattermost-api-reference/blob/master/v4/source/status.yaml
- bot-accounts: https://developers.mattermost.com/integrate/reference/bot-accounts/
- personal-access-token: https://developers.mattermost.com/integrate/reference/personal-access-token/
- interactive-messages: https://developers.mattermost.com/integrate/plugins/interactive-messages/
- WS posted 수신자(멤버십) 포럼: https://forum.mattermost.com/t/websocket-does-not-provide-posted-events-from-other-accounts/14876
- bot post patch 포럼: https://forum.mattermost.com/t/impossible-to-update-a-post-through-api-with-bot-account/7795
- mobile push (HPNS/self-host proxy): https://docs.mattermost.com/deploy/mobile-hpns.html · https://developers.mattermost.com/contribute/more-info/mobile/push-notifications/service/

**Apple 배포 / 푸시**
- Developer ID + notarization: https://developer.apple.com/support/developer-id/
- TestFlight overview (내부 테스터·90일): https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
- background push (전달 비보장·시간당 2~3개): https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- Enterprise Program (100명+ 자격): https://developer.apple.com/programs/enterprise/
- App Store Review Guidelines (1.2 UGC / 3.1.1 IAP): https://developer.apple.com/app-store/review/guidelines/
- Unlisted App Distribution(전체 심사): https://developer.apple.com/support/unlisted-app-distribution/

---

**[표시] 추정·리스크:** ▸ "내부 테스트 = testing(비-production)" 분류 (Enterprise Source Available) — *medium, MM 확인 필요*. ▸ 봇 self-status PUT 동작 — *version-dependent, 1회 실증 필요*. ▸ 모노토닉 seq / actor 토큰 부재 — *추정 medium*. ▸ "스트리밍" = PUT-patch 흉내(네이티브 토큰스트림 아님). ▸ 김인턴 인터페이스 = **불명(블로킹, Phase 0 전 확정)**. ▸ **라이선스 결론은 법률 자문 아님 — 외부 배포/상용 SaaS 전 변호사 검토 필수.**