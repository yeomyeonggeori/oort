# [SUPERSEDED] Sol 인수인계 패킷 — 외부 에이전트 수용 축 (2026-08-12)

> **이 패킷은 실행 정본이 아니다.** #1343 검수에서 사실 오류와 범위 결합을 발견해 다음 패킷으로 대체했다.
>
> **새 정본:** `docs/planning/handoffs/2026-08-12-hosted-agent-pairing-launch-packet.md`
>
> 보존 목적: 2026-08-12 Fable→sol 최초 인수인계의 역사 기록. 아래 항목을 구현 프롬프트나 승인 근거로 사용하지 않는다.

## 대체 사유

1. 종전 문서는 Grok trial 전에 SuperGrok/Cursor 유료 구독이 반드시 필요하다고 단정했다. 현재 공식 안내에는 개인 계정용 one-time trial이 있으며, 실제 노출은 앱에서 확인해야 한다. 새 절차는 **trial-first·구매 금지**다.
2. `work_tool_profile`이 server-rust에 없다고 적었지만 `server/Migrations/029_work_tool_profile.sql`, `momo-t3`, Rust conformance test에 이미 존재한다.
3. `MomoACPHost`가 미구현이라고 적었지만 `workers/WorkHostDaemon/Sources/MomoACPHost`에 구현·테스트가 존재한다. 현재 질문은 “0에서 재건”이 아니라 Rust-native host로의 이식 잔여와 실제 live path다.
4. 독립 inbox/task 도구 6종은 기존 durable agent gateway의 pending/lease/events/complete와 의미가 겹친다. 새 계획은 기존 gateway와 message spine을 **thin MCP binding**으로 재사용한다.
5. managed self-host catalog(ADR-0163), ACP audit(#1345), hosted-agent pairing을 한 승인 체인에 묶어 런칭 경로가 불필요하게 길어졌다. 앞의 두 항목은 deferred/non-blocking 별도 축이다.
6. 봇 “감지”를 외부 roster 열거로 해석했다. v0 정답은 봇이 one-time pairing challenge로 먼저 접속하고 사람이 확인하는 bot-initiated discovery다.
7. 해제가 oort 연결 제거만 다뤘다. 새 계약은 credential 즉시 revoke 뒤 Grok routine+MCP connector 정리 완료까지 `cleanup_pending`을 유지한다.

## 당시 유효했고 새 패킷이 승계한 원칙

- oort는 외부 agent의 provider credential이나 runtime을 소유하지 않는다.
- agent는 `member.kind='agent'`인 1급 멤버이며 Postgres=SoT, Centrifugo=전송 계층이다.
- 외부 hosted agent의 공식 MCP/루틴 표면만 사용하고 private API·credential sharing·reverse engineering을 하지 않는다.
- Grok Bot은 첫 preset/실증 대상일 뿐 코어 프로토콜은 벤더 중립이어야 한다.
- 공개 API·인증·schema 경계 변경은 Accepted ADR 전 구현하지 않는다.

## 역사적 산출물 대응표

| 최초 항목 | #1343 검수 후 위치 |
|---|---|
| Grok 실계정 스파이크 | #1344, one-time trial-first·구매 금지 |
| Agent Port 별도 task surface | ADR-0162 pairing/auth + 기존 gateway thin MCP binding |
| ACP 전면 재랜딩 | #1345 별도/deferred 잔여 감사 |
| managed catalog 즉시 구현 | ADR-0163 Proposed/deferred 별도 축 |
| sol 실행 프롬프트 | 신규 hosted-agent pairing launch packet의 issue DAG |

이 문서에 있던 가격·계정 게이트·파일 부재·구현 상태·wave 순서는 모두 폐기한다.
