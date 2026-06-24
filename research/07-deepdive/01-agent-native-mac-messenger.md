# 에이전트가 1급 구성원인 네이티브 메신저 — 구현 계획 & 방향성 Deep-Dive

> 작성 전제: 1순위 = Swift 네이티브 macOS 데스크탑, 2순위 = iOS 앱스토어. 빠른 GTM. OSS 위에 구축. 상용 비공개(closed-source) 배포 가정. 통합 에이전트 = Hermes agent, internkim(김인턴, 내부개발), openclaw.
>
> **표기 규칙**: `[추정]` = 출처로 확정 안 됨 / `[불명]` = 공개 확인 불가 / `⚠️라이선스` = 비공개 상용 배포 리스크. 코드 차용 판정은 GitHub LICENSE 파일 직접 확인 기준이며 **법률 자문 아님 — 출시 전 변호사 검토 필수**.

---

## 1. 방향성 · 포지셔닝

### 1.1 왜 Mac-first Swift인가

| 근거 | 내용 |
|---|---|
| **에이전트의 실제 작업면(work surface)이 데스크탑** | 코딩·파일조작·터미널·로컬 LLM 추론이 일어나는 곳은 데스크탑이다. 에이전트가 "diff를 보여주고 승인받고 실행"하는 1급 메시지 타입은 데스크탑에서만 자연스럽다. 모바일-퍼스트 메신저(슬랙/디스코드)의 역(逆)을 친다. |
| **로컬 LLM 차별화 = Apple Silicon** | MLX Swift(MIT)는 통합메모리로 온디바이스 추론을 제공하나 **Apple Silicon 전용**(Intel Mac 미지원). 프라이버시·오프라인 에이전트 경로가 Mac에서만 1급으로 성립. https://github.com/ml-explore/mlx-swift |
| **네이티브 단일 코어로 Mac+iOS 코드공유** | SwiftUI + Swift Package로 모델/네트워킹/동기화 코어를 공유하면 2순위 iOS GTM이 저렴해진다. Mattermost(RN 모바일 + Electron 데스크탑)는 코어를 공유 못 해 표면마다 재구현 — 이 비효율을 우리는 처음부터 피한다. |
| **Electron 대비 성능·통합** | Mattermost 데스크탑은 Electron 래퍼. 네이티브 SwiftUI는 메모리·배터리·OS 통합(메뉴바, 알림, 단축키, Spotlight)에서 우월하며 "에이전트가 늘 떠 있는 동료" UX에 부합. https://github.com/mattermost/desktop |

### 1.2 ICP (Ideal Customer Profile)

1. **1차 ICP — AI-native 소규모 개발팀/스타트업(2~15명)**: 이미 Claude/Cursor/내부 에이전트를 쓰며, 에이전트를 "툴"이 아닌 "팀원"으로 다루고 싶은 팀. macOS 보급률 높음. 빠른 의사결정.
2. **2차 ICP — 솔로 빌더 / AI 헤비유저**: 여러 개인 에이전트(김인턴 같은 내부 에이전트 포함)를 한 곳에서 멘션·위임·감사하고 싶은 1인.
3. **명시적 비-타깃(초기)**: 엔터프라이즈(SSO/SCIM/DLP 요구), 비-개발 일반 사무직, 모바일-퍼스트 컨슈머.

### 1.3 한 문장 포지셔닝

> **"에이전트를 봇이 아니라 동료로 — 멘션하고, 위임하고, 그가 한 일을 감사할 수 있는, Mac 네이티브 팀 메신저."**

### 1.4 차별화 화이트스페이스 (Desktop × A2A × Permission)

세 축의 교집합이 경쟁사 공백이다:

- **Desktop-native work surface**: 슬랙/디스코드는 모바일-퍼스트 채팅. 우리는 데스크탑에서 에이전트의 **툴콜·diff·파일 산출물**을 1급 메시지로 렌더. (슬랙조차 에이전트는 app/bot user, 1급 멤버 아님 — https://docs.slack.dev/reference/events/app_mention/ )
- **A2A (Agent-to-Agent)**: 에이전트끼리 같은 채널에서 멘션·협업·위임. 슬랙/Mattermost의 봇 모델은 봇끼리 1급 협업을 전제하지 않는다 → **버리고 재설계** 영역.
- **Permission/Identity 1급화**: 누가(사람) 어떤 에이전트에게 무엇을 위임했고, 에이전트가 무슨 권한으로 무엇을 했는지(subject vs actor 분리) 감사. Microsoft Entra Agent ID, Auth0 Token Vault가 검증한 패턴이지만 메신저에 내장한 제품은 공백. https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities

### 1.5 안티-스코프 (명시적으로 안 한다)

- ❌ Huddles식 WebRTC 음성/영상 (초기 reference_only). https://slack.com/features/huddles
- ❌ 노코드 Workflow Builder 비주얼 캔버스 — 에이전트 자연어 지시가 우월한 대체재.
- ❌ Enterprise SSO/SCIM/DLP — 엔터프라이즈 진입 단계까지 후순위.
- ❌ 자체 E2EE 암호 프로토콜 구현 (libsignal은 ⚠️AGPL이고 백본 부재 — Matrix 채택 시 Olm/Megolm 내장).
- ❌ 페더레이션을 day-1 마케팅 포인트로 삼기 (인프라로는 깔되 노출은 후순위).

---

## 2. 탑티어 메신저 기능 스캔 매트릭스

판정: **adopt**(데이터모델/패턴 재현, 코드 아님) / **adapt**(에이전트 멤버십 위해 개조) / **rebuild_for_agents**(에이전트용 신규 설계) / **drop**(초기 제외, reference_only).

| 기능 | Slack | Mattermost | 우리 MVP 판정 | 비고 |
|---|---|---|---|---|
| **채널/스레드/DM/그룹DM** | public/private/DM/groupDM, thread=parent+replies | Channel(O/P/D), Posts.RootId 스레딩, Props(JSON) | **adapt** | 데이터모델은 검증된 표준. "멤버=사람" 암묵 가정을 actor(human/agent)로 일반화 필요. https://docs.slack.dev/messaging/ |
| **멘션/알림/presence/typing** | mention 기반 알림, presence | user_typing, status_change WS 이벤트 | **🔴 rebuild_for_agents** | 에이전트가 멘션 대상·presence 주체가 되도록 재설계. "에이전트=1급 멤버"의 핵심. |
| **메시지 순서/타임스탬프** | `ts`=채널내 유니크, 전역 모노토닉 미보장 | `CreateAt`(int64 ms) 단독, (CreateAt,Id) 타이브레이크 | **🔴 rebuild_for_agents** | 다수 에이전트 동시 쓰기 시 ms 충돌 비결정 → **서버측 채널별 모노토닉 seq 추가** 필수. https://raw.githubusercontent.com/mattermost/mattermost/master/server/public/model/post.go |
| **리액션** | reaction | Reactions(PostId,UserId,EmojiName) | **adopt** | 단순 메타데이터 관계. |
| **핀/북마크/저장(saved)** | Pins/Channel Bookmarks/Saved | (유사) | **adopt** | 단순 관계 테이블. |
| **검색** | RTS API(외부저장 없는 권한인지 query) | 통합검색 | **🔴 rebuild_for_agents** | 에이전트 grounding의 1급 기능. 권한 인지형 retrieval로 재설계. https://docs.slack.dev/ai/slack-mcp-server/ |
| **파일 업로드/공유** | FileInfo | FileInfo(PostId 참조) | **adopt** | |
| **Canvas / Lists (구조화 산출물)** | Canvas(리비전/코멘트), Lists | Boards(⚠️AGPL) | **🔴 rebuild_for_agents** | 에이전트가 작성/수정하는 문서·표 = 핵심 차별화. 동시편집은 CRDT(automerge/loro). https://slack.com/blog/news/meet-slack-canvas |
| **Clips(음성/영상메시지)** | Clips | — | **drop** | GTM 후순위. |
| **Huddles(WebRTC)** | 오디오/화면공유/AI노트 | Calls(⚠️AGPL) | **drop** | 후순위 rebuild. 필요시 LiveKit(Apache). |
| **Workflow Builder/자동화** | 트리거+조건분기+AI step | Playbooks(코어 Apache, enterprise ⚠️MSL) | **drop** | 에이전트 자연어 계획이 대체. cron 원시요소만 추후 adapt. |
| **앱/봇 플랫폼 + Events API** | Events API(3초 제약), Socket Mode | Webhooks/Bot Account/Apps Framework(Apache) | **adapt** | 봇=2급 모델 버리고 이벤트 구독/인터랙션 모델만 차용. |
| **Block Kit / 인터랙티브 메시지** | Block Kit(비공개 사양) | Interactive Dialog | **🔴 rebuild_for_agents** | 에이전트 승인 카드·툴콜·diff 렌더로 재설계. OSS 재구현(slack-block-builder=MIT)은 참고만. |
| **슬래시 커맨드** | Slash Commands | Slash Commands | **adapt** | 자동완성 패턴 차용. |
| **MCP 인바운드 도구표면** | 호스티드 MCP 서버(search/messages/canvas/users) | — | **adopt** | **우리가 MCP 서버 제공자**가 됨. 개방표준=라이선스 안전. https://docs.slack.dev/ai/slack-mcp-server/ |
| **네이티브 AI(요약/Catch Up)** | Agentforce/Slackbot 에이전트화 | — | **drop→reference** | 사후부착 모델. 패턴만 참고. https://slack.com/blog/news/ai-innovations-in-slack |
| **감사 로그** | Audit Logs API(Grid) | (enterprise) | **adapt(경량)** | 엔터프라이즈 이전에도 에이전트 액션 추적 필수. |
| **SSO/SCIM/DLP** | SAML/SCIM/DLP | (enterprise ⚠️MSL) | **drop** | 엔터프라이즈 진입 시 adapt. |

**에이전트용 재설계(🔴 rebuild) 핵심 7선**: presence/멘션의 actor 일반화, 메시지 순서(모노토닉 seq), 권한인지 검색, 구조화 산출물 동시편집, 에이전트 메시지 타입(툴콜/diff/승인카드), Block Kit 대체 렌더, 멀티에이전트 A2A 동시성 제어.

---

## 3. Mattermost 오픈소스 아키텍처: 차용 가능 vs 코어

> **대전제 1**: Slack 본체는 비공개 SaaS — **코드 차용 대상이 아예 없다**. 차용은 기능 명세·데이터모델·UX 패턴 수준뿐. https://docs.slack.dev/
> **대전제 2**: Mattermost는 컴포넌트별 라이선스가 갈린다. 서버 소스 = **AGPLv3**(v2 아님, LICENSE.txt 원문 확정), Mattermost사 배포 컴파일 바이너리만 MIT, webapp/server/public/i18n/templates = Apache-2.0, server/enterprise = **MSL**(유료 E20 구독 필수, 복제/배포/판매 금지). https://github.com/mattermost/mattermost/blob/master/LICENSE.txt

### 3.1 컴포넌트별 차용 판정표

| 컴포넌트 | 스택 | 라이선스 | 판정 | 비공개 상용 Swift 앱 리스크 |
|---|---|---|---|---|
| **server (백엔드)** | Go, 단일바이너리, PostgreSQL | AGPLv3 | **reference_only** | ⚠️ 코드 차용 시 카피레프트/네트워크 조항 발동 → 전체 소스 공개 의무. **단 한 줄도 import 금지.** https://github.com/mattermost/mattermost/blob/master/LICENSE.txt |
| **server/public (model/REST·WS client)** | Go | **Apache-2.0** | **adapt** | 데이터모델·API 계약을 Swift로 **재구현** 가능. 코드 이식 아님(Go→Swift). |
| **webapp** | TS/React | Apache-2.0 | **reference_only** | 라이선스는 OK지만 React→SwiftUI 직접 이식 불가. UX/상태관리 패턴만. |
| **mobile** | **React Native(JS/TS)** | Apache-2.0 | **🔴 rebuild** | **언어·런타임이 달라 Swift 앱에 코드 직접 차용 불가.** 오프라인 동기화/재연결/캐시 *전략*만 흡수. https://github.com/mattermost/mattermost-mobile |
| **desktop** | Electron | Apache-2.0 | **reference_only** | Swift 네이티브 1순위와 스택 불일치. 멀티서버 탭·딥링크·뱃지 UX만 참고. https://github.com/mattermost/desktop |
| **플러그인 프레임워크** | Go hooks+RPC / TS webapp | (혼합) | **reference_only** | "Mattermost 서버 안에서" 동작하는 확장점. 자체 네이티브 메신저엔 부적합. 개념만. https://developers.mattermost.com/integrate/plugins/ |
| **Apps Framework** | HTTP/서버리스 | **Apache-2.0** | **adapt** | "선언적 폼+액션+서명된 trigger_id" = 에이전트 승인/툴실행 UX의 최적 차용 모델. https://github.com/mattermost/mattermost-plugin-apps |
| **REST API v4** | OpenAPI YAML | (스펙=인터페이스) | **adapt** | swift-openapi-generator로 Swift 클라이언트 생성 가능. 계약은 리스크 거의 없음. https://api.mattermost.com/ |
| **WebSocket 이벤트 모델** | `/api/v4/websocket`, event/data/broadcast | (스펙) | **adapt** | posted/post_edited/typing/reaction_added/status_change 분류를 실시간 레이어 청사진으로. https://github.com/mattermost/mattermost/blob/master/server/public/model/websocket_client.go |
| **데이터모델/DB 스키마** | Posts/Channels/Users/Reactions/Threads | (스키마) | **🔴 rebuild** | 정규화 관계형 구조는 청사진. 단 에이전트 1급화·모노토닉 seq·actor 타입은 신규 설계. https://gist.github.com/icelander/df694981002e047c66f8d0e5cc607947 |
| **Calls (WebRTC)** | Go/TS plugin | **AGPLv3** | reference_only | ⚠️ 코드 차용 불가. 필요시 LiveKit(Apache). |
| **Boards (Focalboard)** | plugin | **AGPLv3** | reference_only | ⚠️ 코드 차용 불가. |
| **Playbooks** | plugin | Apache(코어)+**MSL**(enterprise) | adapt(코어만) | 코어 워크플로 로직만. enterprise 디렉터리 ⚠️제외. |

### 3.2 진짜로 차용할 핵심 (코드 아님, 설계 자산)

1. **WebSocket 이벤트 모델** (event/data/broadcast 봉투 + posted/typing/reaction 타입 분류) — 실시간 레이어 청사진.
2. **데이터모델 스레딩** (`RootId` 기반 parent+replies, `Props` JSON 확장 필드) — 단 `Id`를 모노토닉 seq로 대체.
3. **Apps Framework의 인터랙션 프로토콜** (선언적 폼 + 액션 + 서명 trigger_id) — 에이전트 승인 UX.
4. **OpenAPI v4 계약** — Swift 클라이언트 자동생성 출발점.
5. **봇 모델은 반면교사** — Bot Account(User 흉내)를 답습하지 말고 actor 타입으로 재설계.

---

## 4. 제안 아키텍처

### 4.1 핵심 백엔드 결정: 자체 Vapor vs Matrix에 얹기

| | **옵션 A: Matrix에 얹기 (권고)** | **옵션 B: 자체 백본(Vapor/Hummingbird)** |
|---|---|---|
| 전송/방/멤버십/멀티디바이스 | rust-sdk가 제공(production ready) | 전부 자체 구축 |
| E2EE | Olm/Megolm 내장(Apache-2.0) | libsignal=⚠️AGPL or 자체 구현 |
| 페더레이션 | 개방표준 내장 | 없음 |
| 에이전트 1급화 경로 | Application Service API(가상유저 네임스페이스 예약) | 완전 자유 설계 |
| GTM 속도 | **빠름** (백본 재사용) | 느림(수개월~수년 보안민감 작업) |
| 라이선스 | core matrix-rust-sdk = **Apache-2.0**(임베드 가능). 단 홈서버 Synapse/Dendrite = ⚠️AGPL → 미수정 self-host는 OK, 비공개 수정·SaaS는 Element 상용 라이선스 필요. 회피 시 conduwuit(Apache) | 우리 코드는 비공개 자유 |
| **제어/단순성** | Matrix 이벤트모델·appservice "passive 제약"에 종속. 능동 개입 UX는 클라이언트/게이트웨이로 보완 | 데이터모델 완전 통제(에이전트 1급화·모노토닉 seq·actor 토큰을 그대로 설계) |

**권고 (트레이드오프 명시)**:
- **빠른 GTM·E2EE·페더레이션이 진짜 요구라면 → 옵션 A(Matrix)**. 차별화 노력을 백본이 아니라 에이전트 레이어에 집중. ⚠️ **단 Phase 0에서 macOS에서의 rust-sdk E2EE/슬라이딩싱크 전 기능을 자체 PoC로 검증 필수** — Element가 자사 Swift 패키지를 iOS 전용으로 좁힌 것은 macOS가 Element 1급 지원 대상이 아닐 수 있음을 시사. (matrix-org/matrix-rust-components-swift는 `.macOS(.v12)+.iOS(.v16)` 선언 확인 — https://github.com/matrix-org/matrix-rust-components-swift/blob/main/Package.swift )
- **에이전트 1급 데이터모델(actor 토큰, 모노토닉 seq, 툴콜/diff 메시지 타입, A2A 동시성 제어)을 완전 통제하고 싶고 E2EE·페더레이션이 day-1 필수가 아니라면 → 옵션 B(자체 Vapor/Hummingbird + PostgreSQL)**. 이 제품의 차별화가 전부 "에이전트 멤버십 레이어"에 있다는 점을 감안하면, **옵션 B가 철학적으로 더 정합**할 수 있다. 메신저 백본을 Matrix에 위임하면 우리가 가장 통제하고 싶은 actor/순서/툴콜 모델이 Matrix 이벤트 스키마에 갇힌다.

> **최종 권고**: **Phase 0에서 두 옵션을 병렬 스파이크**하라(아래 6.1). 빠른 GTM 가중치가 절대적이면 A, 에이전트 모델 통제 가중치가 절대적이면 B. **이것이 사용자에게 물어야 할 미결정 #2(7장).**

### 4.2 클라이언트 = SwiftUI 단일 코어 (Mac + iOS 코드공유)

- **공유 Swift Package(`AgentMessengerCore`)**: 모델 / 네트워킹 / WS 레이어 / 동기화 / CRDT / actor·권한. → iOS 2순위 GTM 저렴화.
- **플랫폼별 thin UI 레이어**: macOS(메뉴바/멀티윈도/단축키), iOS(앱스토어 가이드라인 대응).
- **채팅 UI**: ExyteChat(**MIT**, iOS+macOS) 채택 후 에이전트 전용 셀(툴콜 카드·스트리밍·diff·근거표시)로 개조. MessageKit은 macOS 미지원이라 배제. https://github.com/exyte/Chat

### 4.3 저장 / 동기화 / 오프라인 (per-surface split — 핵심 설계 원칙)

동기화 알고리즘은 **단일 전역 선택이 아니라 표면별 분리**가 2025~2026 local-first 정설:

| 표면 | 전략 | 근거 |
|---|---|---|
| **메시지 스트림(append-only)** | 서버권위 **모노토닉 seq + 편집은 LWW**. CRDT 불필요(append-only, 동시편집 희소). | 에이전트 비동기 쓰기는 *순서* 동시성이지 *내용머지* 동시성이 아님. seq로 trivial 해결. |
| **구조화 산출물(Canvas/Lists, 인간×에이전트 공동편집)** | **CRDT**. | 진짜 공동편집. |
| **presence/typing/read-state(휘발성)** | 별도 ephemeral 레이어(LWW KV + TTL) | 내구성 문서와 분리. Yjs Awareness / Loro EphemeralStore가 명시적 1급 primitive. |

- **로컬 저장**: **GRDB.swift(MIT)** — macOS 10.15+/iOS 13+, migrations·observation·SQLCipher. SwiftData는 고빈도 쓰기·동기화에 rough edges로 1순위 배제. https://github.com/groue/GRDB.swift
- **CRDT 백본(Swift 네이티브)**:
  - **Loro(`loro-swift`, MIT)** — **권고**. core post-1.0, **loro-swift v1.13.2(2026-06-15 릴리스 확인, 활발)**, movable list/tree/rich-text, **내장 EphemeralStore(presence)**, UniFFI. 원 리서치가 놓친 더 강한 후보. https://github.com/loro-dev/loro-swift
  - automerge-swift(MIT) — 가능하나 pre-1.0이고 batteries-included `automerge-repo-swift`가 정체(0.3.2, 2024-11). https://github.com/automerge/automerge-swift
  - Yjs/yswift — 네이티브 코어에서 배제(yswift WIP v0.2, 2024-07 정체).
- **오프라인 lessons**: mattermost-mobile(RN+WatermelonDB)은 코드 차용 불가, 재연결·로컬캐시·낙관적 업데이트 *전략*만 흡수.

### 4.4 실시간(WebSocket)

- **옵션 A(Matrix)**: sync/슬라이딩싱크를 rust-sdk가 처리 → WebSocket 직접 관리 불필요.
- **옵션 B(자체)**: 클라이언트 `URLSessionWebSocketTask`(Apple 네이티브) 기본, 압축확장/구형OS 필요 시 Starscream(Apache) 보조. 서버측 Vapor WebSocketKit(MIT) 또는 Hummingbird(Apache). Mattermost event/data/broadcast 봉투 차용. https://github.com/vapor/websocket-kit

### 4.5 푸시(APNs)

- macOS/iOS 공통 APNs. 옵션 B는 자체 서버에서 APNs 발송, 옵션 A는 Matrix push gateway(Sygnal류) 또는 자체 게이트웨이. ⚠️E2EE 시 페이로드 최소화(알림에 평문 본문 금지).

### 4.6 로컬 LLM(MLX) 옵션

- **MLX Swift(MIT)** 온디바이스 추론, iOS+macOS 공유(MLXChatExample). Apple Silicon 전용·메모리 제약 → **클라우드+로컬 하이브리드** 설계. 로컬은 프라이버시/오프라인 경로. https://github.com/ml-explore/mlx-swift

### 4.7 텍스트 아키텍처 다이어그램

```
┌───────────────────────────────────────────────────────────────────────┐
│  CLIENTS (SwiftUI)                                                      │
│  ┌──────────────────────┐        ┌──────────────────────┐              │
│  │ macOS app (1순위)     │        │ iOS app (2순위)       │              │
│  │ 메뉴바/멀티윈도/단축키 │        │ 앱스토어 가이드라인    │              │
│  └──────────┬───────────┘        └──────────┬───────────┘              │
│             └──────────┬─────────────────────┘                          │
│            ┌───────────▼────────────┐                                   │
│            │ AgentMessengerCore      │  (공유 Swift Package)             │
│            │  · 모델/actor/권한       │                                  │
│            │  · 네트워킹 / WS 레이어   │                                  │
│            │  · GRDB(MIT) 로컬저장    │                                  │
│            │  · Loro(MIT) CRDT+presence│                                 │
│            │  · ExyteChat(MIT) UI개조 │  · MLX Swift(MIT) 로컬LLM        │
│            └───────────┬────────────┘                                   │
└────────────────────────┼──────────────────────────────────────────────┘
        실시간 WS / sync  │   APNs 푸시         MCP(인바운드)
                          │
┌─────────────────────────▼─────────────────────────────────────────────┐
│  BACKEND                                                                 │
│                                                                         │
│  옵션 A: Matrix homeserver(미수정 self-host=AGPL OK / 수정·SaaS=상용)    │
│     + matrix-rust-sdk(Apache, 클라 임베드)                              │
│     + Application Service(에이전트=가상유저 1급 멤버)                    │
│  ── 또는 ──                                                              │
│  옵션 B: 자체 Vapor(MIT)/Hummingbird(Apache) + PostgreSQL               │
│     · 채널별 모노토닉 seq · actor 토큰 · 툴콜/diff 메시지 타입(완전통제) │
│                                                                         │
│  ┌──── 두 평면(둘 다 필요, 별개) ──────────────────────────────────┐    │
│  │ (A) 인바운드 MCP 서버 = OAuth2.1 resource server               │    │
│  │     외부/내부 에이전트가 search/messages/canvas/users 호출       │    │
│  │ (B) 아웃바운드 에이전트 실행 루프 = 이벤트버스/큐 + 에이전트워커  │    │
│  │     멘션 이벤트 → 에이전트 기동 → 컨텍스트주입 → 스트리밍 게시    │    │
│  │     ※ (B)는 MCP로 구현 불가 (MCP=클라이언트개시 동기)            │    │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  안전장치(채널 1급): 모노토닉 seq · 라운드 배리어 · 연속자동응답 상한   │
│     · 스텝 하드캡 · 채널별 에이전트 세마포어 · 토큰/비용 서킷브레이커    │
└─────────────────────────────────────────────────────────────────────┘
                          │ AgentTransport (통일 어댑터 인터페이스)
        ┌─────────────────┼──────────────────┬─────────────────┐
   ┌────▼────┐      ┌──────▼──────┐    ┌──────▼──────┐   ┌──────▼──────┐
   │ Hermes  │      │ internkim   │    │ openclaw    │   │ 외부 에이전트 │
   │ agent   │      │ (김인턴)[불명]│    │ (MIT, Node) │   │ Claude/Cursor│
   │ (MIT)   │      │             │    │             │   │             │
   └─────────┘      └─────────────┘    └─────────────┘   └─────────────┘
   MCP/REST/stdio/CLI 중 무엇이든 AgentTransport 하나로 수용
```

---

## 5. 에이전트 통합 모델 & '구성원으로서의 에이전트'

### 5.1 어댑터 추상화 — `AgentTransport`

모든 통합 에이전트가 인터페이스가 다르므로(MCP / OpenAI-호환 REST / stdio CLI / gRPC), **단일 `AgentTransport` 프로토콜**을 두고 어댑터로 흡수:

```
protocol AgentTransport {
  func invoke(context: ThreadContext, tools: [ToolSpec]) -> AsyncStream<AgentEvent>
  // AgentEvent = .partialText | .toolCall(name, args) | .diff | .artifact | .done | .error
}

어댑터: MCPAdapter / RESTAdapter(OpenAI-호환) / StdioCLIAdapter / SocketAdapter
```

이 설계의 검증된 청사진은 **openclaw의 채널 어댑터 모델**(`defineChannelMessageAdapter`, presentation/transport/interactions 3분할, capability 선언 기반). openclaw는 **MIT**라 *구조·프로토콜* 차용은 라이선스 안전하나, **코드는 TypeScript/Node라 Swift로 재구현 필수**. https://docs.openclaw.ai/plugins/sdk-channel-plugins , https://github.com/openclaw/openclaw

### 5.2 세 에이전트 통합 가설 (불명 부분 가정 명시)

| 에이전트 | 확인된 사실 | 통합 가설 | 라이선스 |
|---|---|---|---|
| **Hermes agent** | "Hermes"는 **두 실존 대상**: ① NousResearch Hermes 모델 계열(Hermes 3/4, `<tool_call>` XML 툴콜) ② NousResearch **Hermes Agent 프레임워크**(2026-02, gateway+channels+skills). 둘 다 진짜. https://github.com/nousresearch/hermes-agent | 프레임워크라면 `RESTAdapter` 또는 자체 gateway 프로토콜로 흡수. **[추정]** 정확히 어느 Hermes인지 사용자 확인 필요. | MIT |
| **internkim(김인턴)** | **[불명]** — GitHub/웹/한국어 검색 모두 특정 불가. 사용자 내부 개발 에이전트로 가정. | 인터페이스(MCP/REST/stdio/gRPC) 불명 → **`AgentTransport` 하나만 구현하면 흡수**. day-1 우선 통합 큐. | 불명(내부) |
| **openclaw** | Peter Steinberger 작(Clawdbot→Moltbot→OpenClaw 개명). MIT, TS/Node(+일부 Swift). 채널 어댑터 SDK 보유. Hermes Agent가 `hermes claw migrate`로 openclaw 설정 import = 사실상 경쟁/후발. https://github.com/openclaw/openclaw | **채널 어댑터 모델을 우리 `AgentTransport` 청사진으로 차용**. 코드는 재구현. | MIT |

> ⚠️ **세 에이전트의 실제 런타임 인터페이스는 사용자에게 확인해야 할 미결정 #1(7장).** 어느 쪽이든 `AgentTransport` 추상화 하나로 수용하도록 설계해 의존을 끊는다.

### 5.3 인바운드 vs 아웃바운드 — 두 개의 별개 평면 (핵심 통찰)

> "우리가 MCP 서버가 된다"는 **인바운드 절반만** 해결한다. MCP(2025-11-25)는 정의상 **클라이언트 개시 동기 요청-응답**이며 스펙이 "비요청 서버→클라이언트 메시지 없음"을 명시. **에이전트가 멤버로서 멘션받아 능동 응답하는 아웃바운드 루프는 MCP로 불가능.** https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

| 평면 | 방향 | 구현 | 레퍼런스 |
|---|---|---|---|
| **(A) 인바운드 MCP 서버** | 외부 에이전트 → 우리 메신저 | OAuth 2.1 resource server. search/messages/canvas/users 도구 | Slack MCP 서버. https://docs.slack.dev/ai/slack-mcp-server/ |
| **(B) 아웃바운드 실행 루프** | 우리 서버 → 에이전트 기동 | 이벤트버스/큐 + 워커. 멘션 이벤트→에이전트 기동→컨텍스트 주입→스트리밍 게시. **절대 MCP로 구현 금지** | Slack Events API + Web API 분리패턴. https://docs.slack.dev/apis/events-api/ |

우리는 외부 PUSH를 받는 Slack과 달리 **서버가 곧 호스트**라 HTTP 콜백 왕복 없이 (B)를 내재화 → GTM 더 빠름.

### 5.4 봇이 아니라 멤버로 만드는 데이터모델

```
Member (도메인 통합)
 ├─ kind: human | agent           ← 핵심: actor 타입 1급 컬럼
 ├─ identity: 사람과 동등한 멤버 ID, presence, profile
 ├─ (agent 전용) capabilities: [ToolSpec], transport: AgentTransport ref
 └─ (agent 전용) owner_human: 위임 사람 ref

Message
 ├─ author_member_id (human or agent — 동등)
 ├─ seq: 채널별 모노토닉 int64        ← 순서 1급 (rebuild)
 ├─ logical_clock: Lamport/HLC        ← 멘션-응답 인과 보장
 ├─ type: text | tool_call | tool_result | diff | artifact | approval_request
 └─ props: JSON 확장

AuditEntry  ← day-1 경량 도입
 ├─ actor_agent_id (실행한 에이전트)
 ├─ subject_human_id (위임한 사람)    ← (행위에이전트, 위임자) 쌍 항상 기록
 ├─ action, target, token_act_chain (RFC8693 act.sub 체인)
 └─ timestamp
```

### 5.5 아이덴티티 / 권한 / 감사 (subject vs actor 분리 — day-1)

- **토큰 클레임 분리**: `subject`(위임 사람) + `actor`(실행 에이전트, `act.sub`) + `client`(앱)을 별개 클레임으로. **RFC8693 token exchange** 기반 자체 인가 서버로 구현(Entra Agent ID / Auth0 Token Vault가 검증). **비준 안 된 만료 드래프트 draft-oauth-ai-agents-on-behalf-of-user에 코드 묶지 말 것.** https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02
- **두 경로 명시 구분**: 자율 행동(스케줄러/구독 트리거) = 에이전트 자체 신원(client credentials) / 사람 대행 = 위임 토큰(act 체인 남김).
- **MCP 인바운드 MUST 1:1 구현**: per-request Bearer, RFC8707 resource로 audience 바인딩, audience 불일치 401, RFC9728 메타데이터, PKCE S256, **상류 호출 시 토큰 패스스루 금지**(별도 교환).
- **scope 분리**: 에이전트 전용 scope 세트 ≠ 사람 scope.

### 5.6 멀티에이전트 동시성 & 피드백 루프 폭주 제어 (채널 1급 기능)

어느 프레임워크도 비용캡·채널 세마포어를 기본 제공 안 함 → **제품 차별점**으로 직접 구축:

1. **메시지 순서**: 채널별 모노토닉 seq(단일 라이터/원자적 INCR) + `(seq, server_ts, author_id)` 정렬. 인과 체인은 Lamport/HLC 부착.
2. **연속 자동응답 상한**: AutoGen `max_consecutive_auto_reply` 패턴(에이전트-에이전트 연속 자동응답 차단). https://markaicode.com/fix-infinite-loops-multi-agent-chat/
3. **스텝 하드캡**: LangGraph `recursion_limit=25` 패턴(초과 시 강제 종료 + 사람 호출). https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT
4. **채널별 에이전트 세마포어**: asyncio.Semaphore 패턴을 서버측 1급으로.
5. **시맨틱 루프 감지**: 최근 N 메시지 해시 반복 차단.
6. **토큰/비용($) 서킷브레이커**: 채널/세션별 예산.
7. **Anthropic 레이트리밋 인지 백오프**(백엔드 가정): 429=내 한도(Retry-After→리셋헤더→지터드 지수백오프), 529=서버 과부하(2~5초 단순 재시도, 과금 안 됨), token bucket 버스트를 세마포어+큐로 평탄화. https://www.respan.ai/articles/anthropic-api-rate-limits

> **구조화 산출물 동시편집**은 2층 분리: (a) 문서 본문 = Loro/automerge CRDT(충돌무료 머지), (b) 서버 권위 레코드(상태전이·승인) = 에이전트-인지형 OCC. 초기 GTM은 단순 버전 OCC로 출시, 경합 잦아지면 사전 직렬 랭크로 확장(CoAgent식; ⚠️CoAgent 코드 라이선스 **[불명]**, 아이디어만 차용). https://arxiv.org/html/2606.15376

---

## 6. 단계별 로드맵

### 6.1 Phase 0 — 스파이크 (2~3주)

| 산출물 | 성공기준 | 난관 |
|---|---|---|
| **백엔드 옵션 A/B 병렬 PoC** | macOS에서 matrix-rust-sdk E2EE+슬라이딩싱크 전기능 동작 검증(A) / Vapor+PG 채널·seq·WS 왕복(B). **결정 문서화** | ⚠️ Element가 Swift 패키지를 iOS 전용으로 좁힌 점 — macOS rust-sdk 1급 지원 불확실(자체 검증 필수) |
| `AgentTransport` PoC | 1개 실제 에이전트(openclaw or Hermes)를 멘션→스트리밍 응답까지 | 세 에이전트 실제 인터페이스 [불명] → 사용자 확인 |
| Loro-swift CRDT PoC | macOS+iOS에서 인간×에이전트 Canvas 공동편집 + presence(EphemeralStore) | UniFFI 바이너리 빌드/배포 |
| 라이선스 가드레일 | AGPL/MSL import 금지 CI 체크 + NOTICE 파일 | 트랜지티브 의존 |

### 6.2 Phase 1 — Mac MVP (8~12주)

**In scope**: 채널/스레드/DM(adapt), 모노토닉 seq, presence/typing(actor 일반화), 멘션→에이전트 아웃바운드 루프(B), 권한인지 검색(rebuild), 핀/북마크/저장(adopt), 리액션/파일(adopt), 에이전트 1급 멤버십 + 툴콜/diff/승인카드 메시지 타입(rebuild), 인바운드 MCP 서버(A), 경량 감사 로그, 루프 안전장치(seq/연속응답상한/스텝캡/세마포어/비용캡), APNs.

**Out of scope**: Huddles/WebRTC, Workflow Builder, Canvas 풀 동시편집(읽기/단순편집만), SSO/SCIM/DLP, 페더레이션 노출, iOS.

| 산출물 | 성공기준 | 난관 |
|---|---|---|
| macOS 네이티브 앱(SwiftUI) | 사람+에이전트가 한 채널에서 멘션·스트리밍 응답·툴콜 승인·diff 확인. 3개 에이전트 중 ≥1 통합 | 에이전트 응답 스트리밍 UX, 동시성 폭주 실측 |
| 인바운드 MCP 서버 | 외부 Claude/Cursor가 우리 메신저 search/post 호출(OAuth2.1) | MUST 스펙 정합 |
| 감사 + actor 분리 | 모든 에이전트 액션에 (actor, subject) 쌍 기록 | 토큰 교환(RFC8693) 인가서버 |

### 6.3 Phase 2 — iOS (4~6주)

| 산출물 | 성공기준 | 난관 |
|---|---|---|
| iOS 앱(공유 코어 재사용) | macOS 코어 90%+ 재사용, 앱스토어 심사 통과 | ⚠️앱스토어 가이드라인(UGC 모더레이션·로컬LLM·과금), 백그라운드 WS 제약, APNs |

### 6.4 Phase 3 — 멀티에이전트 / A2A / 결제 (8~12주)

| 산출물 | 성공기준 | 난관 |
|---|---|---|
| A2A 협업 | 에이전트끼리 멘션·위임·협업(라운드 배리어로 폭주 차단) | 동시성/순서 결정성, 비용 폭발 |
| Canvas 풀 동시편집 | 인간×다중에이전트 충돌무료 공동편집(Loro) + 에이전트-인지 OCC | CRDT 스케일/머지 UX |
| 결제 | 좌석/사용량 과금. ⚠️iOS는 앱스토어 IAP 정책 vs 외부결제 검토 | 앱스토어 30% / 외부결제 허용 범위 |
| (선택) 페더레이션/엔터프라이즈 | SSO/SCIM/Audit API adapt | MSL/AGPL 회피 유지 |

---

## 7. 리스크 & 의사결정 필요

### 7.1 리스크 매트릭스

| 범주 | 리스크 | 완화 |
|---|---|---|
| **기술** | macOS에서 matrix-rust-sdk 1급 지원 불확실(Element는 iOS 전용 패키지) | Phase 0 자체 PoC. 실패 시 옵션 B(자체 백본) |
| **기술** | 멀티에이전트 동시성 폭주/비용 폭발 | seq·세마포어·연속응답상한·비용 서킷브레이커 day-1 |
| **기술** | Loro/automerge pre-1.0/UniFFI 빌드 리스크 | Phase 0 검증, Loro(post-1.0) 우선 |
| **⚠️라이선스** | AGPL(Mattermost server/Calls/Boards, Synapse 수정, libsignal, Element X iOS), MSL(Mattermost enterprise) 코드를 비공개 상용에 차용 시 위반 | MIT/Apache 화이트리스트 강제 + CI import 차단 + NOTICE. **출시 전 변호사 검토** |
| **⚠️라이선스** | Matrix 홈서버 비공개 수정·SaaS 시 Element 상용 라이선스 필요 | 미수정 self-host 또는 conduwuit(Apache) 또는 옵션 B |
| **앱스토어** | UGC 모더레이션 요건, 로컬LLM, IAP/외부결제 정책 | Phase 2 사전 가이드라인 검토 |
| **시장** | 슬랙 Agentforce·MCP 등 사후부착 빠른 추격 | "에이전트=1급 멤버 + 데스크탑 work surface" 화이트스페이스 선점 |
| **사양 변동** | MCP 2025-11-25, Slack RTS/MCP는 최신 → 변동 가능 | 착수 전 docs 최신본 재확인 |

### 7.2 사용자에게 물어야 할 미결정 (BLOCKING)

1. **세 에이전트의 실제 런타임 인터페이스** — Hermes agent / internkim(김인턴) / openclaw 각각 MCP server인가, OpenAI-호환 REST인가, stdio CLI인가, gRPC/소켓인가? (특히 **internkim은 공개 확인 불가 [불명]** — 내부 스펙 필요. Hermes는 모델 계열인가 프레임워크인가 **[추정] 확인 필요**.)
2. **백엔드 self-host 여부 / 옵션 A vs B** — Matrix에 얹기(빠른 GTM·E2EE·페더레이션, 단 ⚠️AGPL 홈서버 제약 + 모델 통제 약화) vs 자체 Vapor/Hummingbird(에이전트 모델 완전통제, GTM 느림). E2EE·페더레이션이 day-1 필수인가? 비공개 self-host 운영을 할 것인가?
3. **(보조) 결제·과금 모델 & 엔터프라이즈 진입 시점** — 좌석 vs 사용량, iOS IAP 정책 노출 범위 — Phase 3 설계에 영향.

---

## 8. 출처 목록

**Slack (비공개 — 명세/패턴만)**
- https://docs.slack.dev/ · https://docs.slack.dev/messaging/ · https://docs.slack.dev/block-kit/
- https://docs.slack.dev/ai/slack-mcp-server/ · https://docs.slack.dev/apis/events-api/ · https://docs.slack.dev/reference/events/app_mention/
- https://slack.com/features/huddles · https://slack.com/blog/news/meet-slack-canvas · https://slack.com/blog/news/ai-innovations-in-slack · https://slack.com/blog/news/powering-agentic-collaboration

**Mattermost (라이선스 컴포넌트별)**
- https://github.com/mattermost/mattermost/blob/master/LICENSE.txt (서버 AGPLv3 / Apache 부분 / MIT 컴파일)
- https://github.com/mattermost/mattermost · https://github.com/mattermost/mattermost-mobile · https://github.com/mattermost/desktop
- https://github.com/mattermost/mattermost/blob/master/server/public/model/websocket_client.go · https://api.mattermost.com/
- https://raw.githubusercontent.com/mattermost/mattermost/master/server/public/model/post.go (순서=CreateAt 단독 확인)
- https://gist.github.com/icelander/df694981002e047c66f8d0e5cc607947 (DB 스키마)
- https://github.com/mattermost/mattermost-plugin-apps (Apache) · Playbooks/Calls/Boards LICENSE (위 본문)
- https://developers.mattermost.com/integrate/plugins/ · https://docs.mattermost.com/product-overview/faq-license.html
- https://github.com/mattermost/mattermost-plugin-playbooks/blob/master/server/enterprise/LICENSE (MSL)

**Matrix / 백본**
- https://github.com/matrix-org/matrix-rust-sdk (Apache-2.0) · https://spec.matrix.org/latest/
- https://github.com/matrix-org/matrix-rust-components-swift/blob/main/Package.swift (**macOS 12 + iOS 16 확인**)
- https://github.com/element-hq/element-x-ios/blob/develop/LICENSE (**AGPLv3-only, in-file 예외 없음 — 직접 확인**)
- https://element.io/blog/element-to-adopt-agplv3/ · https://github.com/matrix-org/synapse · https://matrix.org/ecosystem/servers/ (conduwuit)
- https://spec.matrix.org/v1.5/application-service-api/ · https://matrix.org/docs/older/application-services/

**Swift OSS 스택 (MIT/Apache — 차용 가능)**
- https://github.com/exyte/Chat (MIT) · https://github.com/groue/GRDB.swift (MIT) · https://github.com/ml-explore/mlx-swift (MIT)
- https://github.com/loro-dev/loro-swift (**MIT, v1.13.2 2026-06-15 확인, EphemeralStore**) · https://github.com/automerge/automerge-swift (MIT)
- https://github.com/vapor/vapor (MIT) · https://github.com/hummingbird-project/hummingbird (Apache) · https://github.com/vapor/websocket-kit · https://github.com/daltoniam/Starscream (Apache)
- ⚠️배제: https://github.com/signalapp/libsignal (AGPL) · https://github.com/robbiehanson/XMPPFramework (미유지)

**에이전트**
- https://github.com/openclaw/openclaw (MIT) · https://docs.openclaw.ai/plugins/sdk-channel-plugins · https://en.wikipedia.org/wiki/OpenClaw
- https://github.com/nousresearch/hermes-agent · https://nousresearch.com/hermes3 · https://github.com/NousResearch/Hermes-Function-Calling
- internkim/김인턴 = **[불명]** (GitHub/웹/한국어 검색 일치 없음)

**프로토콜 / 인증 / 동시성**
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization · https://modelcontextprotocol.io/extensions/tasks/overview
- https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02 (⚠️비준 안 됨/만료)
- https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities · https://auth0.com/blog/auth0-token-vault-secure-token-exchange-for-ai-agents/ · https://hookdeck.com/blog/mcp-event-gateway
- https://markaicode.com/fix-infinite-loops-multi-agent-chat/ · https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT · https://github.com/crewAIInc/crewAI/discussions/4078
- https://www.respan.ai/articles/anthropic-api-rate-limits · https://arxiv.org/html/2606.15376 (CoAgent, ⚠️코드 라이선스 불명) · https://www.mindstudio.ai/blog/multi-agent-orchestration-patterns

---

### 핵심 take-away 3줄

1. **코드 차용은 MIT/Apache로만** (Loro·ExyteChat·GRDB·MLX·Vapor·matrix-rust-sdk). AGPL(Mattermost server/Calls/Boards, libsignal, Element X iOS)·MSL(enterprise)은 비공개 상용에 절대 import 금지 — 슬랙/Mattermost는 명세·패턴만.
2. **이 제품의 전부는 "에이전트 멤버십 레이어"** — actor 타입(human/agent), 모노토닉 seq, subject/actor 분리 감사, 인바운드 MCP ≠ 아웃바운드 실행루프(둘 다 별개로 구축), 멀티에이전트 폭주 안전장치(채널 1급). 백본은 위임 가능해도 이 레이어는 직접.
3. **BLOCKING 결정 2개**: 세 에이전트의 실제 인터페이스(특히 internkim [불명]), 백엔드 옵션 A(Matrix) vs B(자체) — Phase 0 병렬 스파이크 후 확정.