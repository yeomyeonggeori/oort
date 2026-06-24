# 배포 가능 백본 선정 + 김인턴 인터페이스 추천 리포트

> 맥락: 에이전트(김인턴, internkim — hermes-agent류)가 **1급 구성원**인 메신저. **≤5명 사내 내부 테스트 후 배포 예정** → 닫힌 상용 배포 + 자체 호스팅 SaaS 둘 다 안전한 라이선스(MIT/Apache/BSD/MPL) 필수, **AGPL/GPL은 위험으로 분류**. 클라이언트 = Swift macOS(우선) + iOS.
> 직전 계획 `07-deepdive/02-internal-v0-plan.md` 는 **Mattermost(AGPL) 백본 가정**이었으나, "배포 전제"로 인해 **permissive 백본으로 갱신**한다.
>
> ⚠️ **법률 자문 아님.** 모든 판정은 repo의 LICENSE 파일·공식 문서 등 1차 출처 기반의 **엔지니어링 판단**이다. 닫힌 상용 배포 전 사내/외부 **법무 검토 1회 필수**(특히 open-core EE 경계, OpenSSL 예외, 상표권 조항, FSL "Competing Use" 해석).

---

## 1. 핵심 결론

**왜 MM(Mattermost)을 배포용 백본으로 못 쓰는가:**
Mattermost 서버 **소스 코드는 AGPL-3.0**(또는 Mattermost, Inc.의 상용 라이선스)이다. LICENSE.txt 본문이 명시한다 — *"You may be licensed to use source code ... Under the GNU AGPL v3.0 ... or Under a commercial license available from Mattermost, Inc."* (<https://github.com/mattermost/mattermost/blob/master/LICENSE.txt>, 본 리포트에서 직접 확인). 예외로 *Mattermost, Inc.가 컴파일한 공식 바이너리*는 MIT지만, 우리는 **에이전트를 1급화하기 위해 서버를 수정·자체 빌드해야 하므로** 그 순간 AGPL 카피레프트가 발동한다. 특히 AGPL은 **자체 SaaS 호스팅(네트워크 제공)만으로도 소스 공개 의무를 트리거**하므로, "배포 예정 + 자체 호스팅" 양쪽 요건과 정면 충돌한다. → **배포 대상에서 제외.**

**무엇을 쓸 것인가 (한 줄 추천):**
> **백본 = Zulip(Apache-2.0 풀스택)을 1순위**로, 분산·E2EE가 핵심 요건이면 **Matrix + Tuwunel(Apache-2.0) + matrix-rust-components-swift(Apache-2.0)**를 2순위로. 김인턴은 **hermes-agent(MIT)의 커스텀 플러그인 플랫폼 어댑터(`BasePlatformAdapter`)로 양방향 1급 멤버화**하고, 내부 인터페이스는 **OpenAI 호환 `/v1/chat/completions` + SSE + Hermes/OpenAI 툴콜 + 승인 콜백**으로 표준화한다.

---

## 2. 배포 가능 백본 비교 매트릭스

판정 범례: ✅ closed_ok(닫힌 배포+SaaS 안전) · ⚠️ 조건부/주의 · 🚫 AGPL/GPL 위험(배포 부적합)

| 후보 | 라이선스 (SPDX) | 닫힌 배포 | 자체 SaaS | 스택 | 기능 완성도 | 봇·에이전트 1급화 | Swift 클라 친화 | 성숙도 | 판정 |
|---|---|---|---|---|---|---|---|---|---|
| **Zulip** | `Apache-2.0` (서버+웹+모바일 전부) | ✅ | ✅ | Python/Django + TS/React + Flutter | 매우 높음 (스트림·토픽 스레딩 강점) | 강함 (봇 유저 + outgoing webhook + real-time events) | 중 — 공식 Swift SDK 휴면, REST/events 직접 래핑 필요 | 매우 높음 | ✅ **1순위** |
| **Matrix — Tuwunel 홈서버** | `Apache-2.0` | ✅ | ✅ | Rust 단일 바이너리 | 중상 (federation·E2EE 패스스루; Synapse보다 기능폭 좁음) | 강함 (Application Service API, 가상유저=1급) | 상 — `matrix-rust-components-swift`(Apache) 공식 권장 | 중상 (conduwuit 후계, 활발, 스위스 정부 운영) | ✅ **2순위** |
| ┗ *Matrix — Synapse / Dendrite(element-hq)* | `AGPL-3.0` | 🚫 | 🚫 | Python / Go | 매우 높음(Synapse) | 강함 | (SDK는 Apache로 분리 가능) | 매우 높음 | 🚫 **배포 금지** |
| **Rocket.Chat** | 코어 `MIT` + EE 디렉터리 독점 (`ee/`, `apps/meteor/ee/`) | ⚠️ | ⚠️ | TypeScript/Meteor | 높음 | **매우 강함** (Apps-Engine 샌드박스 봇) | 약 (공식 iOS는 legacy) | 높음 | ⚠️ **EE 분리 빌드 실증 안 됨** (§3 참조) |
| **XMPP — Prosody** | `MIT` | ✅ | ✅ | Lua (경량) | 중 (MUC=채널, MAM 아카이브; 스레드/리치 UX는 클라 구현) | 중 (외부 봇/컴포넌트) | 약 (XMPPFramework 별도 라이선스 확인) | 매우 높음 | ✅ 안전하나 팀챗 UX 부담 |
| **XMPP — Openfire** | `Apache-2.0` | ✅ | ✅ | Java + 관리 콘솔 | 중상 | 중 (플러그인/외부 봇) | 약 | 매우 높음 | ✅ 안전하나 UX 부담 |
| ┗ *XMPP — ejabberd / Tigase* | `GPL-2.0 WITH OpenSSL-exception` / `AGPL-3.0` | 🚫 | 🚫 | Erlang / Java | 매우 높음 | 중 | 약 | 매우 높음 | 🚫 위험 |
| **Tinode** | 서버 `GPL-3.0` / 클라(Swift 포함) `Apache-2.0` | 🚫(서버) | 🚫(서버) | Go(서버) + Swift/Java/RN(클라) | 중 | 중 | 상 (공식 Swift iOS 클라) | 중 | 🚫 **서버 GPL → 배포 부적합** |
| **자체 구축 (Vapor/Hummingbird + Centrifugo)** | `MIT`(Vapor)/`Apache-2.0`(Hummingbird·Centrifugo) + `MIT`(SwiftCentrifuge) | ✅ | ✅ | Swift 서버 + Centrifugo realtime + PostgreSQL | 가변 (직접 구현) | **완전 통제** (에이전트=설계 1급) | **최상** (전 스택 Swift+permissive) | 가변 (자체 책임) | ✅ **3순위 / 풀컨트롤** |
| ┗ *대조군: Mattermost* | 서버 `AGPL-3.0-only` (소스) / `MIT`(공식 바이너리) / `Apache-2.0`(일부 admin·config) | 🚫(수정·자체빌드) | 🚫 | Go + React | 매우 높음 | 강함 (빌트인) | 약 | 매우 높음 | 🚫 **직전 가정 → 폐기** |

**출처(1차):** Zulip Apache <https://github.com/zulip/zulip/blob/main/LICENSE> (직접 확인) · Tuwunel Apache·conduwuit 후계 <https://github.com/matrix-construct/tuwunel> (직접 확인) · Synapse AGPL <https://api.github.com/repos/element-hq/synapse/license> (직접 확인) · Dendrite(element-hq) AGPL <https://api.github.com/repos/element-hq/dendrite/license> (직접 확인) · Mattermost LICENSE.txt <https://github.com/mattermost/mattermost/blob/master/LICENSE.txt> (직접 확인) · Rocket.Chat <https://github.com/RocketChat/Rocket.Chat/blob/develop/LICENSE> · Prosody <https://prosody.im/source> · Openfire <https://github.com/igniterealtime/Openfire> · ejabberd COPYING <https://github.com/processone/ejabberd/blob/master/COPYING> · Tigase <https://github.com/tigase/tigase-server> · Tinode <https://github.com/tinode/chat> (README: 서버 GPL-3.0, 클라 Apache-2.0) · Vapor <https://github.com/vapor/vapor/blob/main/LICENSE> · Hummingbird <https://github.com/hummingbird-project/hummingbird> · Centrifugo <https://api.github.com/repos/centrifugal/centrifugo/license> (직접 확인) · SwiftCentrifuge <https://github.com/centrifugal/centrifuge-swift>.

> ⚠️ **conduwuit 본체는 2026-05-29 archived**(read-only). 라이선스(Apache-2.0)는 동일하게 안전하나 신규 채택은 **Tuwunel**(공식 후계, 2026-06 활발) 또는 Conduit(Apache, GitLab)로. **Dendrite 함정:** 원본 `matrix-org/dendrite`는 Apache지만 archived(2024-11 동결), 활발한 `element-hq/dendrite`는 **AGPL** — "활발한 Dendrite"는 위험.

---

## 3. 라이선스 안전/위험 리스트 (배포 모드별 × 컴포넌트별)

배포 모드 3가지로 분리: **(A) 닫힌 상용 배포** · **(B) 자체 호스팅 SaaS** · **(C) 오픈소스 공개**. 핵심 차이는 **AGPL이 (B)에서도 소스 공개를 트리거**한다는 점, **GPL은 (B) 단순 호스팅엔 약하나 "배포 예정"이면 (A)에서 트리거**된다는 점.

### ✅ 화이트리스트 (MIT / Apache-2.0 / BSD / MPL-2.0) — (A)(B)(C) 모두 안전

| 컴포넌트 | 권장 후보 | SPDX |
|---|---|---|
| **서버 백본** | Zulip / Tuwunel / Conduit / Prosody / Openfire / Centrifugo / NATS / Vapor / Hummingbird | `Apache-2.0` (대부분) · `MIT`(Vapor·Prosody·Centrifugo) |
| **클라 SDK (Matrix)** | matrix-rust-sdk, matrix-rust-components-swift, matrix-ios-sdk | `Apache-2.0` (직접 확인: components-swift) |
| **클라 SDK (realtime)** | SwiftCentrifuge, socket.io-client-swift | `MIT` |
| **E2EE 라이브러리** | vodozemac (Olm/Megolm 현대 구현), libolm(deprecated) | `Apache-2.0` |
| **DB / 영속** | PostgreSQL | `PostgreSQL License`(BSD류) — *원문 직접 인용은 미수행, postgresql.org/about/licence 재확인 권고 (추정)* |
| **에이전트 게이트웨이** | hermes-agent (코어) | `MIT` (직접 확인) |

> ⚠️ **MPL-2.0 주석:** 사용자 기준상 "안전" 범주지만 **파일 단위 약한 카피레프트** — 수정한 *그 파일*만 공개 의무. 신규 파일·바이너리 링크엔 전염 안 됨. 별도 취급하되 화이트리스트 유지.

### 🚫 블랙리스트 (AGPL / GPL) — 위험

| 컴포넌트 | 라이선스 (SPDX) | 위험 발동 지점 |
|---|---|---|
| Mattermost 서버(소스) | `AGPL-3.0-only` | (A) 수정·자체빌드 배포 + **(B) SaaS 네트워크 제공만으로 트리거** |
| Matrix Synapse | `AGPL-3.0-only` (또는 Element 상용) | (A)(B) 둘 다 — 회피 |
| Matrix Dendrite (`element-hq`) | `AGPL-3.0-only` (또는 상용 듀얼) | (A)(B) 둘 다 — 회피 |
| Matrix Element-web / Element X iOS | `AGPL-3.0-only` | 클라이언트 앱 자체 AGPL — **복붙/포크 금지**, SDK만 의존 |
| XMPP Tigase | `AGPL-3.0-only` | (A)(B) 둘 다 |
| XMPP ejabberd | `GPL-2.0-only WITH OpenSSL-exception` | (A) 수정 배포 시 카피레프트 → 보수적 위험(C 전용) |
| Tinode **서버** | `GPL-3.0` | (A) 배포 시 카피레프트 → 위험. *클라(Swift 포함)는 Apache-2.0 안전* |
| Soketi(realtime) | `AGPL-3.0-only` | (A)(B) 둘 다 |
| Liveblocks `@liveblocks/server`·CLI | `AGPL-3.0-or-later` | self-host 백본 용도 시 위험. *client/react/node 패키지는 Apache-2.0* |

### ⚠️ 회색지대 (open-core / source-available) — 운영 전제가 깨지면 위험

| 컴포넌트 | 라이선스 | 판정 핵심 |
|---|---|---|
| **Chatwoot** | 코어 `MIT` + `enterprise/` 독점 | **EE 분리 빌드 실증됨** — Rails `prepend_mod_with` + `ChatwootApp.enterprise?` 가드 + CI가 매 PR마다 `enterprise/` 떼고 CE 테스트 → enterprise/ 제거 시 MIT-only 동작 ✅ (단 메신저보단 고객지원 성격) |
| **Rocket.Chat** | 코어 `MIT` + `ee/`·`apps/meteor/ee/` 독점 | ⚠️ **"EE 디렉터리만 제거"로는 컴파일/구동 안 됨** — 코어가 EE에 하드 import 의존(`Cannot find module '../../../../ee/app/license/server'`), 공식 fossify 스크립트는 디렉터리 삭제만 하고 import 참조 미정리. closed_ok의 **운영 전제(EE 제외 빌드)가 깨진다** → 상당한 수작업 포크 필요 |
| **Convex 백엔드** | `FSL-1.1-Apache-2.0` (source-available, 2년 후 Apache 전환) | "Competing Use"만 금지 → 메신저 자체 운용은 허용 가능성 높으나 사용자 엄격 기준(MIT/Apache/BSD/MPL) **미달** → 위험 분류 |
| **PowerSync 서버** | `FSL-1.1-ALv2` (server) / `Apache-2.0` (swift client) | 서버는 source-available(FSL), **Swift 클라 SDK는 Apache 안전**. 오프라인 동기화 강함이나 FSL이라 보수적 위험 |

> **CI 강제 권고:** open-core 채택 시 **EE 디렉터리 제외를 CI에서 강제**하고, 배포 산출물에 ScanCode/REUSE/cargo-deny/cargo-about 등 **라이선스 스캐너**를 걸어 AGPL/GPL/독점 코드가 섞이지 않았는지 자동 검증. Rust crate의 **transitive 의존성**(일부 MPL/GPL 가능)도 스캔 필수. RocksDB(Tuwunel/Conduit 스토리지)는 `Apache-2.0 OR GPLv2` 듀얼 → Apache 선택 시 무해.

---

## 4. 추천 백본 1~2개 심층

### 4-1. 1순위 — Zulip (Apache-2.0 풀스택)

**왜 배포에 안전한가:** 서버·웹·신규 모바일(zulip-flutter)이 **전부 Apache-2.0**(<https://github.com/zulip/zulip/blob/main/LICENSE>, 직접 확인). 닫힌 상용 배포·자체 SaaS 양쪽에서 라이선스 리스크가 **0**이다. 카피레프트 없음, 특허 부여 포함.

**왜 에이전트 1급화에 맞는가:** Zulip은 **봇 사용자(bot user)**가 1급 개념이다. 김인턴을 봇 유저로 등록하면 사람 사용자와 동일하게 스트림·토픽·DM에 참여한다. 통합 메커니즘:
- **Outgoing webhook bot** — 멘션/DM 시 Zulip이 김인턴 게이트웨이로 POST (<https://zulip.com/api/outgoing-webhooks>)
- **REST API** — 송신
- **`register-queue` + `get-events` 롱폴** — 실시간 수신 (<https://zulip.com/api/real-time-events>)
- 강력한 **스트림(채널)+토픽 스레딩** 모델로 에이전트 대화 컨텍스트 격리에 유리

**트레이드오프 (이중 결손, 1차 출처로 정정):**
1. **에이전트 빌트인 부재:** hermes-agent 공식 빌트인 플랫폼 목록에 **Zulip 없음**(확정, <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/>). → **차단이 아니라 결손.** hermes는 `gateway/platforms/`의 thin-adapter base interface와 범용 Webhook을 제공하므로 **자체 thin adapter 1개 작성** 또는 webhook 경유로 우회 가능(§5 참조).
2. **공식 Swift SDK "완전 부재"는 오류 → 정정:** `zulip/swift-zulip-api`(MIT)가 **실존하나 사실상 휴면**(마지막 커밋 2020-10-27, ~18 stars, 미아카이브, <https://github.com/zulip/swift-zulip-api>). Zulip 코어팀이 유지하는 클라 라이브러리는 **Python/JS 둘뿐**(<https://zulip.com/api/client-libraries>). 공식 모바일은 **Flutter**(네이티브 Swift 아님). → **≤5명 규모면 휴면 라이브러리 의존보다 Zulip REST + register-queue/events API를 Swift에서 직접 래핑**하는 편이 통제 가능.

### 4-2. 2순위 — Matrix + Tuwunel(Apache) + matrix-rust-components-swift(Apache)

**왜 배포에 안전한가:** **완전 permissive 스택 구성이 현실적으로 가능.** 단, 두 함정만 피하면 된다.
- 홈서버 = **Tuwunel** `Apache-2.0` (conduwuit 공식 후계, 2026-06 활발, 스위스 정부 운영; <https://github.com/matrix-construct/tuwunel>, 직접 확인). conduwuit 본체는 2026-05 archived → Tuwunel로.
- 🚫 **Synapse/`element-hq` Dendrite는 AGPL이므로 금지**(직접 확인: <https://api.github.com/repos/element-hq/synapse/license> = AGPL-3.0, <https://api.github.com/repos/element-hq/dendrite/license> = AGPL-3.0).
- 클라 SDK = **matrix-rust-sdk** `Apache-2.0` + **matrix-rust-components-swift** `Apache-2.0`(직접 확인: <https://api.github.com/repos/matrix-org/matrix-rust-components-swift/license>) — **Apple 플랫폼 공식 권장 경로**.
- E2EE = **vodozemac** `Apache-2.0`이 자동 포함 → GPL 의존성 없이 Olm/Megolm 종단간 암호화.
- 🚫 **Element-web / Element X iOS는 AGPL** — UI는 자체 작성, SDK만 의존.

**왜 에이전트 1급화에 맞는가:** Matrix **Application Service(AS) API**가 정식 지원. appservice가 user ID 네임스페이스를 **exclusive**로 등록하면 김인턴(`internkim`) 가상 유저가 **실유저와 구분 불가능하게** 방 입장·발화·멤버목록 표시 가능(<https://spec.matrix.org/latest/application-service-api/>). 라이선스 영향 없음(Matrix spec은 relicense 비대상).

**트레이드오프:**
- federation+E2EE+분산형이 매력. 사내 ≤5명이면 **federation off(폐쇄망) 단일 홈서버**로 시작 후 배포 시 선택적 개방 가능.
- `matrix-rust-components-swift`의 Swift FFI는 공식적으로 **"unstable(API 변경 가능)"** → **버전 핀 고정** 필수. Tuwunel은 Synapse보다 기능 폭이 좁음(고급 룸 기능 일부 차이).

### 결론 비교
- **단순·빠른 팀챗 + 깨끗한 풀스택 라이선스** → **Zulip**.
- **federation·E2EE·분산형·네이티브 Swift SDK가 요건** → **Matrix(Tuwunel)**.
- **에이전트를 설계 1급으로 완전 통제 + 전 스택 Swift** → **자체 구축(Vapor/Hummingbird + Centrifugo)**.

---

## 5. 김인턴(internkim) 인터페이스 추천

### 5-1. hermes-agent 실제 인터페이스 (1차 출처 확인)

- **라이선스:** `MIT`, *"Copyright (c) 2025 Nous Research"* (직접 확인: <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/LICENSE>). 닫힌 상용 + 자체 SaaS 모두 안전.
- **아키텍처:** 단일 게이트웨이 프로세스 + channels + skills + memory(FTS5) + tools/terminal + MCP + cron.
- **1급 호출 인터페이스 = 게이트웨이 내장 API Server**(aiohttp): 기본 바인드 `127.0.0.1:8642`, **OpenAI 호환** `POST /v1/chat/completions`(+ `/v1/responses`, `/v1/models`, `/v1/capabilities`, 세션/잡/런 API).
- **스트리밍 = SSE**(`text/event-stream`, `stream:true`). **WebSocket 엔드포인트 없음**(HTTP+SSE only). chat/completions는 표준 `chat.completion.chunk` + 커스텀 `hermes.tool.progress`; `/v1/responses`는 `response.output_text.delta` 등.
- **인증 = `Authorization: Bearer <API_SERVER_KEY>`**(`hmac.compare_digest` 상수시간 비교) + `X-Hermes-Session-Id`, `X-Hermes-Session-Key`, `Idempotency-Key`.
- **툴콜:** 모델 레벨은 Hermes 계열 `<tools>`/`<tool_call>`/`<tool_response>` XML 규약, **API 표면에서는 OpenAI 함수콜**(`tool_calls` / `function_call`·`function_call_output`)로 노출.

**전제 정정(1차 출처):** 직전 우려였던 *"webhooks가 빌트인 플랫폼으로만 응답 고정"*은 **사실이 아니다.** webhooks.md는 전송 대상이 *"게이트웨이에서 enabled+connected"*면 되며, **플러그인 플랫폼도 자격이 있다**. 그리고 양방향 커스텀 어댑터가 **실제로 지원**된다(직접 확인: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/adding-platform-adapters.md>):

```python
# BasePlatformAdapter (gateway/platforms/base.py) — 추상 메서드
async def connect(self) -> bool      # WebSocket/long-poll/HTTP server 연결 수립
async def disconnect(self) -> None   # 클린 셧다운
async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult  # 능동 송신(아웃바운드)
# 인바운드: self.handle_message(event)  로 MessageEvent를 게이트웨이로 포워드

# 플러그인 등록 (~/.hermes/plugins/<name>/ : plugin.yaml + adapter.py)
def register(ctx):
    ctx.register_platform(
        name="internkim_swift",
        label="Swift Messenger",
        adapter_factory=lambda cfg: SwiftMessengerAdapter(cfg),
        # check_fn, validate_config, env_enablement_fn, max_message_length, platform_hint ...
    )
```

→ 커스텀 플러그인 어댑터는 **인바운드 수신(`handle_message`) + 능동 아웃바운드(`send`)** 양방향이 가능하므로 **김인턴을 1급 멤버로 부착 가능**(확인됨). 단 **out-of-process cron 전송** 시에는 추가로 `standalone_sender_fn` + `cron_deliver_env_var` 필요(in-gateway-process 전송은 불필요).

### 5-2. 추천 — `AgentTransport` 추상화

백본(Zulip/Matrix/자체)과 에이전트 런타임(hermes)을 **분리**하는 Swift 측 추상화. 백본 교체 시 어댑터만 갈아끼우도록.

```swift
public protocol AgentTransport {
    // 단발/스트리밍 채팅 — OpenAI 호환 페이로드
    func chat(_ req: ChatRequest) async throws -> ChatResponse
    func chatStream(_ req: ChatRequest) -> AsyncThrowingStream<ChatEvent, Error>

    // 세션/멱등
    var sessionId: String? { get set }      // X-Hermes-Session-Id
    var idempotencyKey: String? { get set } // Idempotency-Key

    // 툴콜 결과 반환(승인 후) — function_call_output
    func submitToolResult(_ result: ToolResult) async throws

    // 인바운드 1급 멤버 이벤트(메신저 → 에이전트)
    func onInbound(_ handler: @escaping (InboundMessage) -> Void)
}

public enum ChatEvent {
    case textDelta(String)            // response.output_text.delta / chat.completion.chunk
    case toolCall(ToolCall)           // OpenAI function_call (이름·인자)
    case toolProgress(String)         // hermes.tool.progress
    case approvalRequest(Approval)    // 위험 툴 실행 전 사용자 승인 요청
    case completed(FinishReason)      // response.completed
    case error(TransportError)
}

public struct ToolCall  { let id: String; let name: String; let arguments: Data /*JSON*/ }
public struct ToolResult{ let callId: String; let content: Data /*JSON*/; let isError: Bool }
public struct Approval  { let callId: String; let toolName: String; let preview: String }
```

### 5-3. 김인턴 기본 인터페이스 (추천값)

| 항목 | 추천값 | 근거 / 상태 |
|---|---|---|
| 호출 프로토콜 | **OpenAI 호환 `POST /v1/chat/completions`** (기본), 멀티스텝 에이전트는 `/v1/responses` | 1차 출처 확인 |
| 스트리밍 | **SSE** (`text/event-stream`, `stream:true`) | 확인 (WS 없음) |
| 인증 | `Authorization: Bearer <API_SERVER_KEY>` + 세션/멱등 헤더 | 확인 |
| 툴콜 포맷 | API: **OpenAI function-call**, 모델 내부: Hermes XML | 확인 |
| 승인 콜백 | `ChatEvent.approvalRequest` → 사용자 승인 → `submitToolResult` | **가정 → 추천값:** hermes 표면에 명시적 승인 이벤트 타입이 별도 문서화돼 있지 않음. **위험 툴(터미널/파일쓰기/외부전송) 실행 전 클라가 가로채는 승인 게이트를 AgentTransport 레벨에서 강제**할 것을 추천. (추정 표시) |
| 부착 방식 | **커스텀 플러그인 플랫폼 어댑터**(`BasePlatformAdapter` subclass) | 확인 — 양방향 1급화 경로 |
| 어댑터↔Swift 브릿지 | 플러그인(Python, 게이트웨이 호스트 내 실행)이 **WS/HTTP 서버**를 띄우고 Swift 클라가 접속 | **가정 → 추천값** (추정 표시) |
| iMessage 폴백 | 빌트인 `bluebubbles` 경로 존재하나 **네이티브 Swift transport 아님** → 비권장 | 확인 |

> ⚠️ 플러그인 표면은 진화 중(repo 활발, 미아카이브)이므로 **특정 release/commit에 핀 고정**하고 빌드 직전 `base.py`의 추상 메서드 셋을 재확인할 것. 인용 시그니처는 main 기준(직접 확인 시점).

---

## 6. 갱신된 v0 아키텍처 & 마이그레이션

**원칙: "내부 테스트 도구"와 "배포 산출물"의 라이선스를 분리하고, 배포 산출물은 처음부터 permissive를 타깃해 재작업을 없앤다.**

```
┌─────────────────────────────────────────────────────────────┐
│  Swift 클라이언트 (macOS 우선 + iOS)                          │
│   - UI 자체 작성 (AGPL UI 코드 복붙 금지: Element-web 등)     │
│   - AgentTransport 프로토콜 (§5-2)  ← 에이전트 분리           │
│   - ChatBackend 프로토콜            ← 백본 분리(아래 핵심)    │
└───────────────┬──────────────────────────────┬──────────────┘
                │                               │
        ChatBackend 추상화                AgentTransport
                │                               │
   ┌────────────┴───────────┐          ┌────────┴──────────┐
   │ (테스트) MattermostShim │          │ 김인턴 게이트웨이  │
   │   ⚠️ throwaway 하네스    │          │  hermes-agent(MIT) │
   │   배포 산출물에 미포함   │          │  /v1/chat/...+SSE  │
   └────────────────────────┘          │  + 커스텀 플러그인  │
   ┌────────────────────────┐          │    어댑터(양방향)   │
   │ (배포) ZulipBackend     │ ◀━━━━━━━ └───────────────────┘
   │   또는 MatrixBackend     │
   │   permissive 백본 타깃   │
   └────────────────────────┘
```

**핵심 격리 장치 — `ChatBackend` 추상화:**
```swift
public protocol ChatBackend {
    func connect() async throws
    func send(_ msg: OutgoingMessage) async throws -> MessageId
    func subscribe(_ handler: @escaping (IncomingMessage) -> Void)  // events/long-poll/SSE
    func presence() async throws -> [MemberPresence]
    func members(channel: ChannelId) async throws -> [Member]       // 에이전트=1급 멤버
}
```

- **내부 테스트 단계(≤5명):** 직전 계획의 Mattermost는 **throwaway 하네스**로만 사용(빠른 PoC). 단 **반드시 `ChatBackend` 뒤에 격리**하여 배포 산출물에 AGPL 코드가 한 줄도 들어가지 않게 한다. CI에서 라이선스 스캐너로 강제 검증.
- **배포 단계:** `ChatBackend`의 실제 구현을 **`ZulipBackend`(Apache) 또는 `MatrixBackend`(Tuwunel/Apache + matrix-rust-components-swift)**로 교체. 추상화 덕분에 클라 UI·AgentTransport 코드는 재작업 0.

**처음부터 permissive로 타깃해 재작업을 없앨 것:**
1. **AgentTransport / ChatBackend 두 추상화를 v0 초기부터 도입** (백본·에이전트 동시 교체 가능).
2. **Swift 클라 UI는 자체 작성** (Element X iOS 등 AGPL 코드 의존 금지).
3. **E2EE가 필요하면 Matrix 노선**(vodozemac Apache 자동 포함) — 나중에 직접 구현하는 비용 회피.
4. **김인턴 어댑터는 커스텀 플러그인으로** 작성(빌트인 의존 X) → 백본 무관하게 재사용.
5. **빌드 BOM에 컴포넌트별 SPDX 고정** + CI 라이선스 스캐너(ScanCode/REUSE/cargo-deny).

---

## 7. 갱신 로드맵 델타 (`02-internal-v0-plan.md` 대비)

| 항목 | 02 계획(기존) | 갱신(배포 전제) | 변경 사유 |
|---|---|---|---|
| 백본 가정 | Mattermost (AGPL) | **Zulip(Apache) 1순위 / Matrix-Tuwunel(Apache) 2순위** | AGPL은 (A)배포+(B)SaaS 둘 다 트리거 |
| **백본 선택 시점** | 후반(테스트 후 결정) | **앞당김 — v0 착수 시 permissive 백본 확정** | 재작업 제거; 추상화 타깃 명확화 |
| Mattermost 위치 | 배포 백본 | **throwaway 테스트 하네스(`ChatBackend` 뒤 격리)** | 빠른 PoC만, 배포 산출물 제외 |
| 추상화 계층 | (암묵) | **`ChatBackend` + `AgentTransport` 명시적 도입(초기)** | 백본·에이전트 동시 교체성 |
| 에이전트 통합 | (미상세) | **hermes 커스텀 플러그인 어댑터(양방향 1급화) 확정** | webhook-only 우려 정정됨 |
| E2EE | (미상세) | **결정 항목으로 승격**(필요 시 Matrix=vodozemac 자동) | §8 |
| 라이선스 게이트 | (없음) | **CI 라이선스 스캐너 + EE 디렉터리 제외 강제 신설** | 배포 컴플라이언스 |
| 법무 검토 | (없음) | **배포 전 1회 필수 노드 신설** | 닫힌 상용 배포 요건 |

---

## 8. 남은 결정 & 리스크

### 결정해야 할 것
1. **배포 모드 확정 (라이선스 전략에 직결):** 닫힌 상용 배포 / 자체 호스팅 SaaS / 오픈소스 공개 중 무엇인가?
   - 셋 중 무엇이든 **MIT/Apache/BSD/MPL 화이트리스트면 안전**하므로 Zulip·Matrix(Tuwunel)·자체구축은 어느 모드에서도 OK.
   - **오픈소스 공개를 한다면** GPL/AGPL을 쓸 여지가 생기지만(C 모드만), "닫힌 상용 배포 + 자체 SaaS 둘 다 안전" 요건과 충돌하므로 **여전히 화이트리스트 권장**.
   - **open-core(Rocket.Chat/Chatwoot) 채택 시**에만 EE 분리가 모드와 무관하게 운영상 전제가 됨 — Rocket.Chat은 분리 실증 안 됨, Chatwoot은 실증됨.
2. **백본 최종 1개 확정:** Zulip(단순·풀스택 깨끗·Swift SDK 휴면 부담) vs Matrix-Tuwunel(E2EE·federation·네이티브 SDK·FFI unstable) vs 자체구축(풀컨트롤·자체 책임).
3. **김인턴 인터페이스 확정:** OpenAI 호환 `/v1/chat/completions`+SSE+OpenAI 툴콜+승인 게이트를 표준으로 채택할지. 어댑터↔Swift 브릿지 트랜스포트(WS/HTTP) 구체화. (현재 §5의 일부는 가정/추천값 — 핀 고정 후 코드 레벨 재확인 필요)
4. **E2EE 필요 여부:** 필요 → **Matrix(vodozemac Apache 자동)**가 가장 깔끔. 불필요 → Zulip로 단순화. (E2EE 환경에서 에이전트가 1급 멤버로 평문을 읽으려면 디바이스 키 공유 설계 별도 필요 — 추가 검토.)

### 리스크
- **휴면/불안정 의존:** `swift-zulip-api`(2020 무커밋, ~5년) · `matrix-rust-components-swift`(공식 unstable) → 버전 핀 + 포크 유지 부담 또는 REST 직접 래핑.
- **Tuwunel 신생도:** conduwuit 후계로 활발하나 Synapse 대비 기능폭·실사용 이력 짧음.
- **hermes 플러그인 표면 진화:** 미아카이브·활발 → 핀 고정 필수. cron out-of-process 전송 시 `standalone_sender_fn` 누락하면 "No live adapter" 실패.
- **transitive 카피레프트:** Rust crate 의존성 중 MPL/GPL 혼입 가능 → CI 스캔.
- **상표권:** Mattermost/Rocket.Chat 등 상표 조항 별도 검토.

### 출처 목록 (1차, 본 리포트에서 직접 확인 ✔ 표기)
- hermes-agent LICENSE = MIT ✔ <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/LICENSE>
- hermes 플랫폼 어댑터(BasePlatformAdapter/register_platform) ✔ <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/adding-platform-adapters.md>
- hermes 빌트인 플랫폼 목록(Zulip 부재) <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/>
- Zulip LICENSE = Apache-2.0 ✔ <https://github.com/zulip/zulip/blob/main/LICENSE>
- Zulip outgoing webhooks <https://zulip.com/api/outgoing-webhooks> · real-time events <https://zulip.com/api/real-time-events> · client libraries <https://zulip.com/api/client-libraries>
- swift-zulip-api(MIT, 휴면) <https://github.com/zulip/swift-zulip-api>
- Tuwunel = Apache-2.0, conduwuit 후계, 활발 ✔ <https://github.com/matrix-construct/tuwunel>
- Synapse = AGPL-3.0 ✔ <https://api.github.com/repos/element-hq/synapse/license>
- Dendrite(element-hq) = AGPL-3.0 ✔ <https://api.github.com/repos/element-hq/dendrite/license>
- matrix-rust-components-swift = Apache-2.0 ✔ <https://api.github.com/repos/matrix-org/matrix-rust-components-swift/license>
- Centrifugo = Apache-2.0 ✔ <https://api.github.com/repos/centrifugal/centrifugo/license>
- Mattermost LICENSE.txt = AGPL-3.0(소스)/MIT(바이너리) ✔ <https://github.com/mattermost/mattermost/blob/master/LICENSE.txt>
- Matrix Application Service API <https://spec.matrix.org/latest/application-service-api/>
- Element AGPLv3 전환 블로그 <https://element.io/blog/element-to-adopt-agplv3/>
- Tinode(서버 GPL-3.0 / 클라 Apache-2.0) <https://github.com/tinode/chat>
- Prosody MIT <https://prosody.im/source> · Openfire Apache <https://github.com/igniterealtime/Openfire> · ejabberd COPYING <https://github.com/processone/ejabberd/blob/master/COPYING>
- SwiftCentrifuge MIT <https://github.com/centrifugal/centrifuge-swift> · Vapor MIT <https://github.com/vapor/vapor/blob/main/LICENSE> · Hummingbird Apache <https://github.com/hummingbird-project/hummingbird>
- PowerSync consistency <https://docs.powersync.com/architecture/consistency>

---

**(추정 표시 요약)** PostgreSQL License는 원문 직접 인용 미수행(공지 기준, postgresql.org/about/licence 재확인 권고). §5-3의 승인 콜백·어댑터↔Swift 브릿지 트랜스포트는 hermes 문서에 명시적 표준이 없어 **가정 기반 추천값**이며 핀 고정 후 코드 레벨 재확인 필요. Ably/Pusher 가격은 3자 비교 기반 추정. 본 판정 전부 **법률 자문 아님** — 배포 전 법무 검토 1회 필수.