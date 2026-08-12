# Grok Bot 연동 가능성 리서치 — trial-first 재검수 (2026-08-12)

> 발제: 사용자가 Grok Bot에서 만든 호스팅 Bot을 oort의 팀메이트로 연결할 수 있는지, 유료 구독 없이 먼저 실증할 수 있는지 검토한다.
>
> 판정: **Bot을 oort가 자동 열거·호출·반입하는 경로는 문서화돼 있지 않다. 반대로 Bot이 oort의 원격 MCP를 소비하고 routine으로 inbox를 확인하는 경로는 유력하며, 개인 one-time trial로 먼저 검증한다.** 제품 방향은 “Grok 전용 연동”이 아니라 **Bring your hosted agent**, Grok Bot은 첫 preset이다.

## 1. 결론부터

1. **선결제는 실증의 필수조건이 아니다.** 공식 문서는 개인 사용자에게 one-time trial을 안내한다. 실제 계정에 trial이 노출되는지 먼저 확인하고, 노출되지 않으면 구매하지 않은 채 spike를 blocked로 남긴다.
2. **자동 Bot 감지는 v0에서 불가능한 문제를 풀려는 접근이다.** 공개 Bot roster/control API가 문서화돼 있지 않으므로 계정을 긁거나 Bot 목록을 가져오지 않는다. 사용자가 선택한 Bot이 one-time pairing 값으로 oort에 먼저 접속하게 해 감지한다.
3. **연동 표면은 custom MCP + routine이다.** custom MCP의 Grok Bot 내 실제 노출, 인증 방식, routine 최소 주기와 cleanup UI는 trial에서 확인해야 하는 `runtime-unverified`다.
4. **연결 해제는 두 단계다.** oort credential은 즉시 revoke하고, 공개 routine/connector 삭제 API가 문서화돼 있지 않은 동안에는 provider UI에서 deterministic routine과 MCP connector를 제거한 뒤 사용자가 완료를 확인한다.
5. **Cursor Cloud Agents는 별도 기회다.** 공개 API가 더 넓어도 Grok Bot roster/run을 대신 노출하는 우회 API는 아니다.

## 2. 공식 사실과 실측 대기 항목

판정 표기:

- **검증됨:** 2026-08-12 공식 문서 또는 현행 oort 코드로 확인
- **runtime-unverified:** 로그인 뒤 제품 UI 또는 실제 네트워크 왕복이 있어야 확인
- **추정 금지:** 공개 문서에서 찾지 못했으므로 존재·부재를 절대 단정하지 않고 제품 계약으로 사용하지 않음

| 항목 | 판정 | 결과 |
|---|---|---|
| 계정 한도 | 검증됨 | 한 계정의 **Bot과 group chat 합계가 최대 50**이다. “Bot 50개” 또는 “50은 routine만”으로 단순화하면 틀린다. |
| routine 한도 | 검증됨 | **Bot당 routine 최대 50**이다. 계정 한도와 별개의 수치다. |
| 개인 trial | 검증됨 | 개인 사용자를 위한 **one-time trial**이 문서화돼 있다. trial 노출 여부는 계정/지역/rollout 상태에 따라 UI 확인이 필요하다. |
| 영구 무료 tier | 추정 금지 | 공식 문서가 one-time trial을 안내한다는 사실만 쓴다. trial 이후 가격·결제는 live checkout 확인 없이 계약에 고정하지 않는다. |
| Bot roster/run/control API | 추정 금지 | 2026-08-12 공개 문서에서 Bot ID, roster, group chat, run을 열거·호출하는 API를 찾지 못했다. “xAI API가 없다”는 뜻은 아니다. |
| routine/connector delete API | 추정 금지 | 공개 control/delete API를 찾지 못했다. 따라서 자동 cleanup을 약속하지 않는다. |
| custom MCP | 검증됨/runtime-unverified | custom remote MCP connector 개념은 공식 문서에 있다. **개인 Grok Bot trial UI에서 노출되는지와 auth 방식은 실측 대기**다. |
| routine wake-up | 검증됨/runtime-unverified | routine과 schedule/event 개념은 공식 문서에 있다. 최소 주기, event→MCP 폐곡선, 지연 SLA는 실측 대기다. |
| 실행 격리 | 검증됨 | 한 사용자의 Bot들이 persistent computer의 파일·브라우저 session·cookie·CLI credential을 공유한다. Bot별 보안 격리 모델로 간주하면 안 된다. |
| provider 선택 | 검증됨 | Grok Bot은 호스팅된 runtime/model bundle이다. oort가 Bot의 provider/model을 선택하는 경로가 아니다. |

공식 문서:

- [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)
- [Grok Bot — Bots](https://docs.x.ai/grok-bot/bots)
- [Get started](https://docs.x.ai/grok-bot/get-started)
- [Skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Grok connectors](https://docs.x.ai/grok/connectors)
- [Custom MCP tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)

## 3. 무엇이 가능한가

### 3.1 채택: Bot이 oort로 다이얼인

사용자가 Grok Bot에 oort의 원격 MCP endpoint를 connector로 등록하고, deterministic routine이 oort inbox를 확인하게 한다.

```text
Grok Bot routine wakes
        │
        v
oort Agent Port (MCP 2026-07-28)
        │
        ├─ one-time pairing / active credential
        ├─ durable inbox cursor
        ├─ existing thread read + message send facade
        └─ existing gateway pending/lease/events/complete binding
        │
        v
Postgres SoT → transactional outbox → Centrifugo transport
```

이 경로는 xAI/Cursor credential을 oort에 전달하지 않는다. 사용자가 oort에서 발급한 connection-scoped credential을 자기 Bot connector에 설정한다. 실제 인증 형태는 trial에서 확인한 뒤 ADR-0162 승인 시 봉인한다.

### 3.2 채택: 사용자 의도 기반 pairing

v0 감지는 roster discovery가 아니라 handshake다.

1. 사용자가 oort에서 “호스팅 에이전트 연결”을 시작하면 서버가 전용 agent member, paused profile, pairing connection을 원자 생성한다.
2. Grok preset이 endpoint, one-time pairing 값, deterministic connector/routine 이름을 보여준다.
3. Bot이 먼저 handshake하면 oort가 `detected`로 표시한다.
4. 사람이 dedicated agent member, channel, permission을 확인한 뒤 pairing challenge와 별도인 active credential을 발급/교환한다. 그 credential proof와 member unpause가 같은 activation 경계에서 끝난 뒤에만 `active`가 된다.

이 방식은 공개 roster 권한이 없어도 사용자가 의도한 Bot만 연결하며, account scraping이나 reverse API가 필요 없다.

### 3.3 별도 lane: Cursor Cloud Agents

Cursor Cloud Agents API는 durable agent/follow-up run, no-repo agent, cloud/self-hosted machine, remote/stdio MCP, SSE/artifact/usage 등 별도 자동화 표면을 제공한다. 그러나 Grok Bot ID나 group chat을 노출하는 문서화된 proxy가 아니다.

따라서 Cursor Cloud Agents를 평가할 때는 **Grok Bot 우회 연동**이 아니라 별도 direct-API hosted agent 후보로 이슈를 분리한다.

- [Cursor Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)

## 4. 무엇을 하지 않는가

- xAI/Cursor 계정 cookie, session 또는 credential을 oort에 저장
- 비공개 endpoint reverse engineering, browser scraping, credential replay
- Bot/group chat roster를 자동 열거했다고 표시
- Bot definition, memory, shared-computer file을 export/import했다고 표시
- 공개 API 근거 없이 routine/MCP connector를 자동 생성·삭제
- custom MCP가 개인 trial에 반드시 보인다고 사전 약속
- routine을 실시간 webhook처럼 홍보하거나 응답 SLA를 약속

공식 UI, custom MCP, routine, 공개 API 범위만 사용한다. 약관 해석과 상용 배포 판단은 법률 자문이 아니며 공개 런칭 전 별도 법무 검토가 필요하다.

- [xAI Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy)
- [xAI Consumer Terms](https://x.ai/legal/terms-of-service)
- [Cursor Terms](https://cursor.com/terms-of-service)

## 5. oort 코드 감사가 바꾼 설계

초안은 기존 자산을 과대평가하고 순서 계약을 잘못 사용했다.

| 초안 전제 | 코드 감사 | 교정 |
|---|---|---|
| Rust `/v1/mcp/drive`가 기반으로 존재 | route는 은퇴 중인 Swift에 있고, Rust에는 MCP crate/router가 없다 | Rust MCP 2026-07-28 foundation부터 만든다 |
| 단일 `after_seq`로 inbox poll | `message.seq`는 channel-local | 별도 durable cross-channel `inbox_seq`를 둔다 |
| MCP `task_claim/complete/release`를 새로 설계 | Rust gateway에 pending/lease/renew/release/events/complete가 이미 존재 | MCP는 gateway의 thin binding만 제공한다 |
| MCP Tasks와 oort job이 같은 상태기계 | MCP Tasks는 long-running RPC result handle | job/run SoT는 현행 gateway에 유지한다 |
| 정적 bearer 확정 | Grok connector의 실제 auth 지원 미실측 | trial 결과 뒤 static bearer/OAuth를 봉인한다 |

MCP 기준은 [2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/)다. 은퇴한 Swift 구현의 2025-06-18 wire shape를 새 Rust 서버에 복사하지 않는다.

## 6. trial-first 실증 계약

### 6.1 선행조건

- 사용자가 Grok Bot 앱 설치를 명시적으로 승인하고 본인이 로그인/consent를 처리한다.
- oort/Codex는 password, MFA, Cursor/Grok session cookie, 결제 정보를 받거나 기록하지 않는다.
- 계정에 one-time trial이 보이면 사용한다. 보이지 않으면 **결제 없이** #1344를 account-gated로 남긴다.
- test workspace와 non-production data만 쓴다.

### 6.2 최소 실측표

| 단계 | 확인할 것 | 성공 기준 | 실패 시 처리 |
|---|---|---|---|
| Trial | 개인 one-time trial 노출 | 결제 없이 Bot 1개 생성 가능 | 구매하지 않고 blocked evidence 기록 |
| Connector | custom remote MCP 추가 | test endpoint discovery/handshake 도달 | 지원 plan/UI/auth 조합을 사실로 기록 |
| Auth | header/OAuth/redirect/proxy 특성 | raw secret을 로그에 남기지 않고 연결 | ADR-0162 D4를 관측값에 맞춰 수정 |
| Pairing | one-time handshake | `pairing_pending → detected`, replay 거부 | generic client 구현은 계속, Grok preset 보류 |
| Routine | deterministic routine 실행 | inbox read 후 test thread에 1회 idempotent reply | 최소 주기/지연을 runtime-unverified로 유지 |
| Cleanup | routine/connector 제거 | oort revoke 후 provider UI cleanup 확인 | `cleanup_pending` 유지, 자동 삭제 주장 금지 |

### 6.3 기록할 evidence

- 앱/문서 version과 확인 시각
- trial 노출 여부와 plan 이름(가격·결제 정보 제외)
- MCP protocol/auth capability와 redacted request metadata
- routine trigger 종류·최소 주기·관측 지연
- pairing replay/revoke/cleanup 결과
- `runtime-unverified`로 남은 항목과 재현 절차

실제 token, endpoint secret, cookie, 개인 workspace 내용은 screenshot·로그·이슈·문서에 남기지 않는다.

## 7. 연결 해제와 기대 사용자 경험

연결 해제 버튼은 “외부 Bot을 삭제”하지 않는다.

1. oort credential을 즉시 revoke하고 connection 전용 agent member를 pause해 새 read/write/job 요청을 막는다.
2. 상태를 `cleanup_pending`으로 바꾼다.
3. connection manifest의 deterministic 이름으로 Grok routine과 MCP connector 제거 단계를 보여준다.
4. 공개 cleanup API가 없으면 사용자가 provider UI에서 제거한 뒤 완료를 확인한다.
5. 과거 member, message, task/run history는 보존한다.

이 분리는 외부 artifact 정리가 늦어져도 oort 권한은 즉시 차단하면서, 정리되지 않은 routine이 계속 비용을 쓰거나 오류를 내는 상황을 사용자에게 숨기지 않는다.

## 8. 제품·사업 판단

Grok Bot 자체의 관심을 런칭에 활용하되 제품의 moat를 특정 vendor에 두지 않는다.

- 상위 메시지: **Bring your hosted agent**
- 검증 후 보조 메시지: **Grok Bot도 몇 단계로 연결할 수 있습니다**
- 기대효과: agent 배포·운영 허들이 없는 사용자를 빠르게 oort 팀 협업에 유입
- 방어선: 같은 Agent Port에 다른 MCP-capable hosted agent를 연결할 수 있어 vendor rollout 변화에 종속되지 않음
- 정직한 한계: wake-up·비용·지연·routine 지속성은 provider가 소유하며 실시간성을 보장하지 않음

## 9. 권장 실행 순서

1. **사실·ADR 정합:** 본 문서와 ADR-0162를 승인 가능한 형태로 정리한다.
2. **trial-first spike:** 결제 없이 실제 MCP/auth/routine/cleanup capability를 확인한다.
3. **generic MCP foundation:** Grok과 무관한 test client로 discovery/auth/revoke/rate-limit을 닫는다.
4. **pairing + durable inbox:** dedicated member/paused profile 원자 생성, bot-initiated 감지, 별도 active proof+unpause, cross-channel cursor를 구현한다.
5. **gateway/conversation binding:** 기존 message/gateway 상태기계를 얇게 노출한다.
6. **Grok preset과 disconnect UX:** deterministic routine, 상태 진행, cleanup checklist를 제공한다.
7. **실계정 E2E 후 런칭 evidence:** 카피에 쓸 수 있는 범위만 검증값으로 승격한다.

이 순서는 trial이 막혀도 vendor-neutral foundation을 버리지 않게 하고, 반대로 지원되지 않는 Grok auth를 미리 구현하는 낭비를 막는다.
